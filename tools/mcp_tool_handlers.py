"""Registry-facing sync handlers for MCP tools and utility tools (resources/prompts), plus the per-call recovery
ladder: trust gating, circuit breaker, auth (401) refresh, session-expired reconnect and dead-stdio respawn retry."""

import logging
import asyncio
import contextvars
import inspect
import json
import os
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any, Callable, Dict, List, Optional, Tuple
from tools.registry import tool_error
from tools.ansi_strip import strip_unicode_tags
from tools import approval_context as _approval_context
from tools import approval_prompt as _approval_prompt
from tools import approval_smart as _approval_smart
from tools.mcp_tool_common import _exc_str, _sanitize_error, mcp_field, _core
from tools import mcp_tool_loop as _loop
from tools.mcp_tool_content import (
    _MCP_HARD_RESULT_CAP_CHARS, _cache_mcp_audio_block, _cache_mcp_image_block,
    _render_mcp_dropped_block_notice, _render_mcp_resource_block, _strip_reserved_meta_keys,
    _truncate_mcp_text_result)
from tools.mcp_tool_errors import _is_auth_error, _is_session_expired_error

logger = logging.getLogger("tools.mcp_tool")
_MISSING = object()

_NEEDS_REAUTH_MSG = (
    "MCP server '{s}' requires re-authentication. Run `hermes mcp login {s}` (or delete the tokens file under "
    "~/.hermes/mcp-tokens/ and restart). Do NOT retry this tool — ask the user to re-authenticate.")
_STDIO_NO_RESPAWN_MSG = (
    "MCP server '{s}' stdio subprocess had exited (this is not a timeout — the call never reached the server). A "
    "respawn was requested but no fresh session came back within {t:.0f}s. Wait a few seconds before retrying; if it "
    "keeps failing the server is not starting and needs the user.")
_STDIO_DIED_AGAIN_MSG = (
    "MCP server '{s}' respawned its stdio subprocess and it exited again immediately. The server is not starting "
    "cleanly — do NOT retry this tool; ask the user to check the server's command and its stderr log.")


def _canonical_home(value: Any) -> str:
    return os.path.realpath(os.path.expanduser(str(value)))


def _mcp_approval_home(server_name: str, *, state_key=None,
                       registration_home: Optional[str] = None) -> Optional[str]:
    """Resolve the profile that owns one MCP approval request.

    A captured state key is authoritative. Otherwise use the server's registration
    home, a unique metadata owner, or the current home outside multiplex mode. An
    ambiguous multiplex owner fails closed before any prompt or transport work.
    """
    if isinstance(state_key, tuple):
        return state_key[0]
    if registration_home:
        return _canonical_home(registration_home)

    from agent.secret_scope import is_multiplex_active
    multiplex = is_multiplex_active()
    lookup_key = state_key if state_key is not None else _core._server_state_key(server_name)
    with _core._lock:
        server = _core._servers.get(lookup_key)
        if server is None and not multiplex:
            server = _core._servers.get(server_name)
        server_home = getattr(server, "registration_home", None)
        if server_home:
            return _canonical_home(server_home)
        profile_homes = set()
        for owner_map in (_core._servers, _core._lazy_server_configs,
                          _core._tool_read_only_hints):
            for key in owner_map:
                if isinstance(key, tuple) and len(key) == 2 and key[1] == server_name:
                    profile_homes.add(key[0])
    if len(profile_homes) == 1:
        return next(iter(profile_homes))

    if multiplex:
        return None
    from hermes_constants import get_hermes_home
    return _canonical_home(get_hermes_home())


def _trust_prompt(server_name: str, tool_name: str) -> Optional[str]:
    """Keep the current upstream trust-tier prompt for explicitly untrusted servers."""
    try:
        answer = _approval_prompt.request_elicitation_consent(
            f"MCP tool '{tool_name}' on UNTRUSTED server '{server_name}' wants to run. This tool is write-capable "
            f"(no readOnlyHint=true annotation) and may modify external state.",
            f"Server '{server_name}' is configured 'trust: untrusted'. "
            f"Approve to run '{tool_name}' once, or deny to block it.",
            surface=f"mcp-trust/{server_name}")
    except Exception as exc:
        logger.error("MCP trust gate: approval check failed for %s.%s: %s", server_name, tool_name, exc, exc_info=True)
        return tool_error(f"MCP tool '{tool_name}' on untrusted server '{server_name}' was blocked: the approval "
                          f"system was unavailable (fail-closed).")
    if answer == "accept":
        return None
    logger.info("MCP trust gate: user %s '%s' on untrusted server '%s'",
                "cancelled" if answer == "cancel" else "denied", tool_name, server_name)
    return tool_error(f"The user did not approve running write-capable MCP tool '{tool_name}' on untrusted server "
                      f"'{server_name}'. The command was NOT run. Do not retry without explicit user direction.")


def _native_mcp_approval(server_name: str, tool_name: str, args: Optional[dict],
                         trust: str) -> Optional[str]:
    """Apply the released native mode/yolo approval contract to one write call."""
    from agent.redact import redact_sensitive_text
    from tools import approval

    # Explicit trust-tier protection remains in force when mode=off or session yolo
    # would otherwise bypass the native approval path.
    if approval.is_approval_bypass_active():
        return _trust_prompt(server_name, tool_name) if trust == _core._TRUST_UNTRUSTED else None

    sensitive_keys = {
        "authorization", "proxy-authorization", "access_token", "refresh_token", "id_token",
        "token", "api_key", "apikey", "client_secret", "password", "passwd", "auth", "jwt",
        "secret", "private_key", "key", "credential", "credentials",
    }
    normalized_sensitive_keys = {item.replace("-", "_") for item in sensitive_keys}

    def _approval_safe(value: Any, key: str = "") -> Any:
        normalized_key = key.strip().lower().replace("-", "_")
        if (normalized_key in normalized_sensitive_keys
                or normalized_key.endswith(("_token", "_secret", "_password", "_credential"))):
            return "«redacted-secret»"
        if isinstance(value, dict):
            return {str(child_key): _approval_safe(child_value, str(child_key))
                    for child_key, child_value in value.items()}
        if isinstance(value, (list, tuple)):
            return [_approval_safe(item) for item in value]
        if isinstance(value, str):
            return redact_sensitive_text(value, force=True, redact_url_credentials=True)
        return value

    try:
        encoded_args = json.dumps(
            _approval_safe(args if isinstance(args, dict) else {}),
            ensure_ascii=False, sort_keys=True, default=str,
        )
    except Exception:
        encoded_args = "{}"
    display_target = redact_sensitive_text(
        f"MCP {server_name}.{tool_name}\narguments: {encoded_args}",
        force=True, redact_url_credentials=True,
    )
    description = (
        f"MCP tool '{tool_name}' on server '{server_name}' can modify external state because "
        "readOnlyHint=true was not supplied."
    )

    if _approval_context._get_approval_mode() == "smart":
        verdict = _approval_smart._smart_approve(display_target, description)
        if verdict == "approve":
            return None
        if verdict == "deny":
            return tool_error(
                f"MCP tool '{tool_name}' on server '{server_name}' was BLOCKED by smart approval. "
                "The RPC was NOT sent. Do not retry without explicit user direction."
            )

    try:
        answer = _approval_prompt.request_elicitation_consent(
            display_target, description, surface=f"mcp-tool/{server_name}"
        )
    except Exception as exc:
        logger.error("MCP native approval failed for %s.%s: %s", server_name, tool_name, exc, exc_info=True)
        return tool_error(f"MCP tool '{tool_name}' on server '{server_name}' was blocked: the approval system "
                          "was unavailable (fail-closed).")
    if answer == "accept":
        return None
    return tool_error(
        f"The user did not approve MCP tool '{tool_name}' on server '{server_name}'. The RPC was NOT sent. "
        "Do not retry without explicit user direction."
    )


def _lookup_mcp_metadata(server_name: str, state_key,
                         registration_home: Optional[str]):
    """Find discovery metadata, including a unique owner when the active home is unknown."""
    from agent.secret_scope import is_multiplex_active
    multiplex = is_multiplex_active()
    key = state_key if state_key is not None else _core._server_state_key(server_name, registration_home)
    with _core._lock:
        hints = _core._tool_read_only_hints.get(key)
        if hints is None and key != server_name and not multiplex:
            hints = _core._tool_read_only_hints.get(server_name)
        if hints is None and state_key is None and multiplex:
            matches = [
                (candidate, value)
                for candidate, value in _core._tool_read_only_hints.items()
                if isinstance(candidate, tuple) and len(candidate) == 2 and candidate[1] == server_name
            ]
            if len(matches) == 1:
                key, hints = matches[0]
            elif len(matches) > 1:
                return key, None, _core._TRUST_FULL, True
        trust = _core._server_trust_levels.get(key)
        if trust is None and key != server_name and not multiplex:
            trust = _core._server_trust_levels.get(server_name)
    return key, hints, trust or _core._TRUST_FULL, False


def _trust_gate_check(server_name: str, tool_name: str, args: Optional[dict] = None,
                      state_key=None, registration_home: Optional[str] = None) -> Optional[str]:
    """Run profile-owned native approval, retaining the explicit upstream trust gate."""
    state_key, hints, trust, ambiguous = _lookup_mcp_metadata(
        server_name, state_key, registration_home,
    )
    if ambiguous:
        return tool_error(
            f"MCP tool '{tool_name}' was blocked because its profile approval scope could not be resolved"
        )
    metadata_present = hints is not None
    read_only = (hints or {}).get(tool_name) is True
    if read_only:
        return None

    # Preserve the upstream trust-only path for callers with no discovery metadata
    # (and therefore no released approval owner to resolve).
    if not metadata_present:
        return _trust_prompt(server_name, tool_name) if trust == _core._TRUST_UNTRUSTED else None

    approval_home = _mcp_approval_home(
        server_name, state_key=state_key, registration_home=registration_home,
    )
    if approval_home is None:
        return tool_error(
            f"MCP tool '{tool_name}' was blocked because its profile approval scope could not be resolved"
        )
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    token = set_hermes_home_override(approval_home)
    try:
        return _native_mcp_approval(server_name, tool_name, args, trust)
    finally:
        reset_hermes_home_override(token)


def _check_circuit_breaker(server_name: str, state_key=None) -> Optional[str]:
    """Open-breaker error, or None when calls may proceed. After the cooldown the breaker is
    half-open: the next call probes; success resets, failure re-bumps and re-arms the cooldown."""
    key = state_key if state_key is not None else _core._server_state_key(server_name)
    failures = _core._server_error_counts.get(key, 0)
    age = time.monotonic() - _core._server_breaker_opened_at.get(key, 0.0)
    if failures < _core._CIRCUIT_BREAKER_THRESHOLD or age >= _core._CIRCUIT_BREAKER_COOLDOWN_SEC:
        return None
    return tool_error(f"MCP server '{server_name}' is unreachable after {failures} consecutive failures. "
                      f"Auto-retry available in ~{max(1, int(_core._CIRCUIT_BREAKER_COOLDOWN_SEC - age))}s. Do NOT retry "
                      f"this tool yet — use alternative approaches or ask the user to check the MCP server.")


def _acquire_call_server(server_name: str, tool_timeout: float, state_key=None):
    """``(server, None)`` when a call may be dispatched, else ``(None, error)``. No session: a
    reconnect may be completing, so wait briefly before a breaker strike; still down -> ask the
    server task to rebuild (probing a dead transport would re-arm the breaker forever)."""
    from tools import mcp_tool_discovery as _discovery  # lazy: discovery -> registration -> handlers cycle
    not_connected = tool_error(f"MCP server '{server_name}' is not connected")
    server = _discovery._get_connected_server_for_call(server_name, state_key)
    wait = min(5.0, float(tool_timeout or 5.0))
    if server and (server.session or _loop._wait_for_server_session_ready(server, timeout=wait)):
        return server, None
    _core._bump_server_error(server_name, state_key)
    if server and _loop._signal_reconnect(server):
        return None, tool_error(f"MCP server '{server_name}' transport is down; reconnect requested. Do NOT retry this "
                                f"tool immediately — give it a few seconds to come back.")
    return None, not_connected


def _result_is_error(result) -> bool:
    """True only for a JSON payload carrying an ``error`` key (non-JSON = success)."""
    try:
        return "error" in json.loads(result)
    except (json.JSONDecodeError, TypeError):
        return False


def _record_call_outcome(server_name: str, result, state_key=None) -> Any:
    """Breaker bookkeeping: an error payload from the tool itself still counts as a strike."""
    (_core._bump_server_error if _result_is_error(result) else _core._reset_server_error)(server_name, state_key)
    return result


def _strike(server_name: str, message: str, state_key=None, **extra) -> str:
    """Breaker strike + the ``tool_error`` payload for *message*."""
    _core._bump_server_error(server_name, state_key)
    return tool_error(message, **extra)


def _mcp_loop_running() -> bool:
    return _core._mcp_loop is not None and _core._mcp_loop.is_running()


def _lookup_reconnectable_server(server_name: str, require_loop: bool = False, state_key=None):
    """The registered server object when it can be signalled to reconnect, else None.
    With *require_loop*, also None unless the MCP loop is running (nothing to wait on)."""
    with _core._lock:
        key = state_key if state_key is not None else _core._server_state_key(server_name)
        srv = _core._servers.get(key)
    ok = srv is not None and hasattr(srv, "_reconnect_event") and (_mcp_loop_running() or not require_loop)
    return srv if ok else None


def _retry_once(server_name: str, retry_call, op_description: str, what: str, state_key=None):
    """Re-run ``retry_call`` after a recovery step. Returns the result (closing the breaker)
    when it is not an error payload; None when the retry raised or errored (caller falls through)."""
    try:
        result = retry_call()
    except Exception as retry_exc:
        logger.warning("MCP %s/%s retry after %s failed: %s", server_name, op_description, what, retry_exc)
        return None
    if _result_is_error(result):
        return None
    _core._reset_server_error(server_name, state_key)
    return result


def _handle_auth_error_and_retry(server_name: str, exc: BaseException, retry_call, op_description: str,
                                 state_key=None):
    """OAuth recovery + one retry; None when *exc* is not an auth error. ``handle_401`` decides
    viability; if viable, signal a reconnect (fresh credentials), wait ready, retry once. Any
    failure returns the structured ``needs_reauth`` error so the model stops refreshing."""
    if not _is_auth_error(exc):
        return None
    from tools.mcp_oauth_manager import get_manager
    try:
        recovered = _loop._run_on_mcp_loop(lambda: get_manager().handle_401(server_name, None), timeout=10)
    except Exception as rec_exc:
        logger.warning("MCP OAuth '%s': recovery attempt failed: %s", server_name, rec_exc)
        recovered = False
    if recovered:
        srv = _lookup_reconnectable_server(server_name, state_key=state_key)
        # Recovery + reconnect is independent evidence of viability: close the breaker here, not only on
        # retry success (else a failing retry pins it open forever).
        if srv is not None and _loop._signal_reconnect_and_wait(
                server_name, srv, op_description=f"{op_description} after OAuth recovery", timeout=15):
            _core._reset_server_error(server_name, state_key)
        result = _retry_once(server_name, retry_call, op_description, "auth recovery", state_key)
        if result is not None:
            return result
    return _strike(server_name, _NEEDS_REAUTH_MSG.format(s=server_name), state_key=state_key,
                   needs_reauth=True, server=server_name)


def _handle_session_expired_and_retry(server_name: str, exc: BaseException, retry_call, op_description: str,
                                      state_key=None):
    """Transport reconnect + one retry on session expiry; None to fall through. Skips
    ``handle_401``: the token is valid, only the server-side session is stale.

    Unlike :func:`_handle_auth_error_and_retry`, this does **not** call the OAuth manager's ``handle_401`` —
    the access token is still valid, only the server-side session state is stale. Setting
    ``_reconnect_event`` causes the server task's lifecycle loop to tear down the current
    ``streamablehttp_client`` + ``ClientSession`` and rebuild them, reusing the existing OAuth provider
    instance. See #13383.
    """
    srv = (_lookup_reconnectable_server(server_name, require_loop=True, state_key=state_key)
           if _is_session_expired_error(exc) else None)
    if srv is None:
        return None
    logger.info("MCP server '%s': %s failed with session-expired error (%s); signalling transport reconnect "
                "and retrying once.", server_name, op_description, exc)
    if not _loop._signal_reconnect_and_wait(server_name, srv, op_description=op_description, timeout=15):
        logger.warning("MCP server '%s': reconnect did not ready within 15s after session-expired error; "
                       "falling through to error response.", server_name)
        return None
    return _retry_once(server_name, retry_call, op_description, "session reconnect", state_key)


class _StdioChildExited(RuntimeError):
    """Stdio subprocess gone when (or while) a call ran. Deliberately NOT a TimeoutError."""


def _handle_stdio_child_exited_and_retry(server_name: str, exc: Exception, retry_call, op_description: str,
                                         state_key=None):
    """Respawn a dead stdio child and retry once; None if not our error. Never spawns itself: it
    sets ``_reconnect_event`` and waits, so spawn frequency stays governed by ``run()``'s
    rapid-drop budget. Single-shot: a child that dies again reports and stops.

    Why retrying here cannot hot-cycle respawns: this function never spawns anything. It sets
    ``_reconnect_event`` (one signal, same as before) and waits for the server task to publish a fresh
    session. Spawn frequency stays governed entirely by ``run()``'s rapid-drop budget, which parks a
    transport that keeps dropping without proving healthy (#62212).
    """
    if not isinstance(exc, _StdioChildExited):
        return None
    reconnected = False
    srv = _lookup_reconnectable_server(server_name, state_key=state_key)
    if srv is not None:
        logger.info("MCP server '%s': %s found the stdio subprocess dead (%s); respawning and retrying once.",
                    server_name, op_description, exc)
        if _mcp_loop_running():
            reconnected = _loop._signal_reconnect_and_wait(
                server_name, srv, op_description=op_description, timeout=_core._STDIO_RESPAWN_WAIT_SEC)
        else:  # No MCP loop to wait on (non-async adapters, tests): still request the respawn.
            _loop._signal_reconnect(srv)
    if not reconnected:
        return _strike(server_name, _STDIO_NO_RESPAWN_MSG.format(s=server_name, t=_core._STDIO_RESPAWN_WAIT_SEC),
                       state_key=state_key)
    try:
        return _record_call_outcome(server_name, retry_call(), state_key)
    except _StdioChildExited as retry_exc:
        # Died again right after respawn: broken server; run()'s budget takes it to the park.
        logger.warning("MCP server '%s': %s stdio subprocess exited again right after respawn (%s); not retrying "
                       "further.", server_name, op_description, retry_exc)
        return _strike(server_name, _STDIO_DIED_AGAIN_MSG.format(s=server_name), state_key=state_key)
    except Exception as retry_exc:
        logger.warning("MCP %s/%s retry after stdio respawn failed: %s", server_name, op_description, retry_exc)
        return _strike(server_name, _sanitize_error(
            f"MCP call failed after respawning the stdio subprocess for '{server_name}': "
            f"{type(retry_exc).__name__}: {_exc_str(retry_exc)}"), state_key=state_key)


def _dispatch(server_name: str, server: Any, op: str, call, tool_timeout: float, recoverers,
              on_final_failure: Callable[[BaseException], None], record_outcome: bool = False,
              state_key=None) -> str:
    """Mark the call started on *server* (doubles may lack ``mark_tool_call``), run coroutine function *call*
    on the MCP loop and, on failure, walk ``recoverers`` (``(server_name, exc, retry_call, op) -> Optional[str]``,
    None = not its kind; order matters). Unrecovered exceptions go through ``on_final_failure`` and become the
    generic call-failed error. ``record_outcome`` applies breaker bookkeeping to the FIRST attempt only."""
    if callable(getattr(server, "mark_tool_call", None)):
        server.mark_tool_call()

    def call_once():
        return _loop._run_on_mcp_loop(call, timeout=tool_timeout)

    try:
        result = call_once()
        return _record_call_outcome(server_name, result, state_key) if record_outcome else result
    except InterruptedError:
        return tool_error("MCP call interrupted: user sent a new message")
    except Exception as exc:
        for recover in recoverers:
            recovered = recover(server_name, exc, call_once, op, state_key)
            if recovered is not None:
                return recovered
        on_final_failure(exc)
        return tool_error(_sanitize_error(f"MCP call failed: {type(exc).__name__}: {_exc_str(exc)}"))


@asynccontextmanager
async def _track_inflight_rpc(server: Any, server_name: str, op: str):
    """Register the running RPC so teardown can fail it fast. A deliberate teardown
    (``_reconnecting`` set first) turns the cancel into a retryable RuntimeError; external
    cancels propagate unchanged. Doubles without ``_inflight_tasks`` skip tracking.

    Every user-visible request family wraps its RPC in this context (#48069 salvage). If a deliberate
    reconnect/shutdown teardown cancels the task (``_fail_inflight_calls`` sets ``_reconnecting`` first),
    the cancel is converted into a clean retryable RuntimeError instead of a raw CancelledError; external
    cancels (caller timeout, user interrupt) propagate unchanged.
    """
    inflight, task = getattr(server, "_inflight_tasks", None), asyncio.current_task()
    tracked = task is not None and inflight is not None
    if tracked:
        inflight.add(task)
    try:
        yield
    except asyncio.CancelledError:
        if getattr(server, "_reconnecting", False):
            raise RuntimeError(f"MCP {op} on '{server_name}' was aborted by a reconnect teardown; retry the "
                               f"request on the rebuilt session") from None
        raise
    finally:
        if tracked:
            inflight.discard(task)


async def _call_tool_racing_stdio_death(server, server_name: str, tool_name: str, args: dict):
    """``session.call_tool`` that fails fast when the stdio child is/gets dead: pre-call (a dead
    child must not hold the slot for the full timeout) and mid-call (race against
    ``_watch_stdio_children``). Both raise :class:`_StdioChildExited` for the respawn path, which
    owns the reconnect signal. callable()/``is True`` because MagicMock attributes are truthy."""
    # Fast-fail (#81995): a stdio subprocess that is already dead must not own this call slot — fail
    # immediately instead of waiting out the full tool timeout on a transport nobody will ever answer.
    _stdio_dead = getattr(server, "_stdio_children_dead", None)
    if callable(_stdio_dead) and _stdio_dead() is True:
        raise _StdioChildExited(f"MCP stdio subprocess for '{server_name}' had already exited when the call was dispatched")
    _call_coro = server.session.call_tool(tool_name, arguments=args)
    _watch_children = getattr(server, "_watch_stdio_children", None)
    if not (inspect.iscoroutinefunction(_watch_children) and asyncio.iscoroutine(_call_coro)):
        # Stubbed sessions return a non-awaitable, or there is no child-watcher to race: plain await.
        return await _call_coro if asyncio.iscoroutine(_call_coro) else _call_coro
    # Fast-fail machinery (#81995): the RPC races a stdio-children watcher so a dead subprocess fails the
    # call immediately instead of riding out the full tool timeout.
    rpc_task = asyncio.ensure_future(_call_coro)
    watch_task = asyncio.ensure_future(_watch_children())
    try:
        done, _pending = await asyncio.wait({rpc_task, watch_task}, return_when=asyncio.FIRST_COMPLETED)
        if watch_task in done and not rpc_task.done():
            rpc_task.cancel()
            raise _StdioChildExited(f"MCP stdio subprocess for '{server_name}' exited mid-call")
        return await rpc_task
    finally:
        watch_task.cancel()
        if not rpc_task.done():
            rpc_task.cancel()
        await asyncio.gather(rpc_task, watch_task, return_exceptions=True)


# ---------------------------------------------------------- result rendering

def _error_result_text(result) -> str:
    """Concatenated text of an ``isError`` result's blocks (EmbeddedResource error payloads
    carry text under ``.resource.text``)."""
    texts = (getattr(b, "text", None) or getattr(getattr(b, "resource", None), "text", None) for b in (result.content or []))
    return "".join(str(t) for t in texts if t)


def _render_content_blocks(result, server_name: str) -> Tuple[str, int]:
    """Text passes through; image/audio blocks are cached (MEDIA: tags); resource blocks are
    materialized rather than silently dropped; unsupported blocks become an inline drop notice
    (kimi-code#3227). Returns ``(text, usable_parts)`` — the count of REAL rendered blocks
    (whitespace-only text and drop notices excluded) that the structuredContent arbitration uses."""
    parts: List[str] = []
    usable_parts = 0
    # MCP tool results can also include ImageContent blocks (screenshot / Blockbench / Playwright etc.);
    # cache those via the gateway's image-cache helper so they flow through Hermes' MEDIA: tag convention
    # and out to messaging adapters that render images natively. Without this, image blocks were silently
    # dropped and the agent got an empty response. Distilled from #17915 (c3115644151) and #10848
    # (gnanirahulnutakki), both too stale to cherry-pick. #10848's approach (integrate with Hermes' MEDIA
    # tag + cache_image_from_bytes) was the cleaner of the two — plugs into existing infrastructure.
    for block in (result.content or []):
        if getattr(block, "text", None):
            parts.append(strip_unicode_tags(block.text))
            if block.text.strip():
                usable_parts += 1
            continue
        rendered = _cache_mcp_image_block(block) or _cache_mcp_audio_block(block) or _render_mcp_resource_block(block, server_name)
        if rendered:
            parts.append(rendered)
            usable_parts += 1
            continue
        block_type = getattr(block, "type", None) or type(block).__name__
        if block_type in {"text", "resource", "audio", "image"}:  # benign empty render
            logger.debug("MCP %s: content block type %r rendered empty", server_name, block_type)
        else:
            logger.warning("MCP %s: dropping unsupported content block type %r", server_name, block_type)
            # Surface the drop to the MODEL, not just the log: a silent drop leaves the agent
            # believing the tool returned less than it did, with no way to recover.
            parts.append(_render_mcp_dropped_block_notice(block, block_type))
    # Hard-cap pathological payloads; ordinary large results pass to spillover.
    return _truncate_mcp_text_result("\n".join(parts)), usable_parts


def _capped_structured_content(result):
    """``structuredContent`` (or None); over the hard cap it degrades to the head+tail
    truncated JSON string (multi-MB JSON flood guard)."""
    # Hard-cap pathological payloads before they propagate (#56059); ordinary large results pass untouched
    # to the spillover layer.
    # content and structuredContent are ALTERNATIVES — never both forwarded (ported from
    # MoonshotAI/kimi-code#3234). Spec-following servers already render their data into content (the
    # verbatim dual-emit SHOULD, or a faithful human reorganisation), so forwarding both sent the same
    # information to the model twice. content wins whenever it rendered anything usable; there is no
    # reliable signal that the structured payload is richer than what the server put in content (semantic
    # equality misses faithful reorganisations, size ratios misjudge both directions), so no heuristic is
    # attempted. structuredContent fills in only when the content blocks rendered effectively empty, which
    # keeps structuredContent-only servers working. Server-level `_meta` is also surfaced (ported from
    # MoonshotAI/kimi-code#2596): servers return namespaced metadata there (validated contracts,
    # browser-handoff payloads, ...) that was previously invisible to the agent. Protocol-reserved keys are
    # dropped first (kimi-code#2600) — per the MCP spec's key-name rules a prefix is reserved when a
    # `modelcontextprotocol` or `mcp` label is followed by at least one more label (e.g.
    # `modelcontextprotocol.io/...`, `tools.mcp.com/...`); those carry host/protocol plumbing, not
    # model-facing data. Unprefixed and vendor-namespaced keys (`com.example.mcp/...`) pass through — their
    # semantics belong to the server.
    structured = mcp_field(result, "structured_content", "structuredContent")
    try:
        as_json = json.dumps(structured, ensure_ascii=False, default=str) if structured is not None else ""
    except (TypeError, ValueError):
        return structured
    return _truncate_mcp_text_result(as_json) if len(as_json) > _MCP_HARD_RESULT_CAP_CHARS else structured


def _render_call_tool_result(result, server_name: str) -> str:
    """Pure: ``CallToolResult`` -> handler JSON. ``content`` and ``structuredContent`` are
    ALTERNATIVES, never both forwarded (kimi-code#3234): spec-following servers already render
    their data into content, so forwarding both sent it twice. content wins whenever it rendered
    anything usable (no richness heuristic is attempted — none is reliable); structuredContent
    fills in only when the blocks rendered effectively empty, keeping structuredContent-only
    servers working. ``_meta`` minus reserved keys is always surfaced."""
    if mcp_field(result, "is_error", "isError", False):
        return tool_error(_sanitize_error(_truncate_mcp_text_result(_error_result_text(result) or "MCP tool returned an error")))
    text_result, usable_parts = _render_content_blocks(result, server_name)
    structured = _capped_structured_content(result)
    meta = _strip_reserved_meta_keys(mcp_field(result, "meta", "meta"))
    if structured is not None and usable_parts > 0:
        structured = None  # drop notices do not count as usable content
    if structured is None and meta is None:
        return json.dumps({"result": text_result}, ensure_ascii=False)
    # Key order is part of the output: "result" leads when there is text, otherwise "_meta" precedes it.
    payload: Dict[str, Any] = {"result": text_result} if text_result else {}
    # Cap structuredContent too — a malicious server could flood context via a multi-MB JSON payload
    # (#56059). When the serialized form exceeds the hard cap, replace it with the truncated string (head +
    # tail preserved) so it degrades gracefully instead of flooding downstream.
    if structured is not None:
        payload["structuredContent" if text_result else "result"] = structured
    if meta is not None:
        payload["_meta"] = meta
    payload.setdefault("result", text_result)
    try:
        return json.dumps(payload, ensure_ascii=False)
    except (TypeError, ValueError):  # Non-serializable metadata: drop the extras, keep the call.
        return json.dumps({"result": text_result}, ensure_ascii=False)


def _make_tool_handler(server_name: str, tool_name: str, tool_timeout: float,
                       registration_home: Optional[str] = None):
    """Sync registry handler (``handler(args_dict, **kwargs) -> str``) calling an MCP tool via the background loop."""
    op = f"tools/call {tool_name}"
    state_key = _core._server_state_key(server_name, registration_home)

    def _handler(args: dict, **kwargs) -> str:
        if _core._server_state_key(server_name) != state_key:
            return tool_error(
                f"MCP tool '{tool_name}' is not registered for the active profile"
            )
        # Security boundary: untrusted-server write tools need approval before ANY transport work (incl. lazy spawn).
        error = _trust_gate_check(
            server_name, tool_name, args, state_key, registration_home,
        ) or _check_circuit_breaker(server_name, state_key)
        if error is not None:
            return error
        server, error = _acquire_call_server(server_name, tool_timeout, state_key)
        if server is None:
            return error

        async def _call():
            async with server._rpc_lock, _track_inflight_rpc(server, server_name, op):
                server._pending_call_context = contextvars.copy_context()  # for the elicitation callback
                try:
                    result = await _call_tool_racing_stdio_death(server, server_name, tool_name, args)
                finally:
                    server._pending_call_context = None
            if getattr(server, "_mark_session_proven", None) is not None:  # round-trip done: transport healthy
                server._mark_session_proven()
            return _render_call_tool_result(result, server_name)

        def _on_failure(exc):
            _core._bump_server_error(server_name, state_key)
            logger.error("MCP tool %s/%s call failed: %s", server_name, tool_name, exc)
        return _dispatch(
            server_name, server, op, _call, tool_timeout,
            (_handle_stdio_child_exited_and_retry, _handle_auth_error_and_retry, _handle_session_expired_and_retry),
            _on_failure, record_outcome=True, state_key=state_key)
    return _handler


def _make_utility_handler(op: str, log_label: str, rpc, render, required: Optional[str] = None):
    """``(server_name, tool_timeout) -> sync handler`` for one utility tool: ``rpc(session, args,
    server_name)`` awaited under ``_rpc_lock``, ``render(result, server_name)`` -> JSON-able
    payload, ``required`` validated before any transport work."""
    def _factory(server_name: str, tool_timeout: float, registration_home: Optional[str] = None):
        state_key = _core._server_state_key(server_name, registration_home)
        def _handler(args: dict, **kwargs) -> str:
            if _core._server_state_key(server_name) != state_key:
                return tool_error(f"MCP tool for server '{server_name}' is not registered for the active profile")
            from tools import mcp_tool_discovery as _discovery  # lazy: import cycle
            server = _discovery._get_connected_server_for_call(server_name, state_key)
            if not server or not server.session:
                return tool_error(f"MCP server '{server_name}' is not connected")
            if required and not args.get(required):
                return tool_error(f"Missing required parameter '{required}'")

            async def _call():
                async with server._rpc_lock:
                    result = await rpc(server.session, args, server_name)
                return json.dumps(render(result, server_name), ensure_ascii=False)
            return _dispatch(
                server_name, server, op, _call, tool_timeout,
                (_handle_auth_error_and_retry, _handle_session_expired_and_retry),
                lambda exc: logger.error("MCP %s/%s failed: %s", server_name, log_label, exc),
                state_key=state_key)
        return _handler
    return _factory


def _pick(obj, *specs) -> dict:
    """``{out_key: value}`` for each ``(out_key, attr[, truthy])`` present on *obj* (presence check so SDK models
    and stubs behave alike; ``truthy`` also skips falsy). Key order = spec order."""
    entry = {}
    for out_key, attr, *truthy in specs:
        value = getattr(obj, attr, _MISSING)
        if value is not _MISSING and (value or not (truthy and truthy[0])):
            entry[out_key] = value
    return entry


def _render_resource_list(all_resources, server_name: str) -> dict:
    resources = []
    for r in all_resources:
        entry = _pick(r, ("uri", "uri"), ("name", "name"), ("description", "description", True))
        if "uri" in entry:
            entry["uri"] = str(entry["uri"])
        mime = mcp_field(r, "mime_type", "mimeType")
        if mime:
            entry["mimeType"] = mime  # camelCase: this is the tool's own JSON output shape
        resources.append(entry)
    return {"resources": resources}


def _render_read_resource(result, server_name: str) -> dict:
    parts: List[str] = []
    for block in getattr(result, "contents", []):
        if getattr(block, "text", None) is not None:
            parts.append(strip_unicode_tags(block.text))
        elif getattr(block, "blob", None) is not None:  # binary -> document cache, like EmbeddedResource blocks
            rendered = _render_mcp_resource_block(SimpleNamespace(type="resource", resource=block), server_name)
            parts.append(rendered or f"[binary data, {len(block.blob)} bytes]")
    return {"result": "\n".join(parts)}


def _render_prompt_list(all_prompts, server_name: str) -> dict:
    prompts = []
    for p in all_prompts:
        entry = _pick(p, ("name", "name"), ("description", "description", True))
        if getattr(p, "arguments", None):
            entry["arguments"] = [{"name": a.name, **_pick(a, ("description", "description", True), ("required", "required"))}
                                  for a in p.arguments]
        prompts.append(entry)
    return {"prompts": prompts}


def _render_get_prompt(result, server_name: str) -> dict:
    messages = []
    for msg in getattr(result, "messages", []):
        entry = _pick(msg, ("role", "role"))
        if hasattr(msg, "content"):
            entry["content"] = strip_unicode_tags(msg.content.text if hasattr(msg.content, "text") else str(msg.content))
        messages.append(entry)
    return {"messages": messages, **_pick(result, ("description", "description", True))}


_make_list_resources_handler = _make_utility_handler(
    "resources/list", "list_resources",
    lambda session, args, sn: _core._paginate_full_list(session.list_resources, "resources", sn), _render_resource_list)
_make_read_resource_handler = _make_utility_handler(
    "resources/read", "read_resource",
    lambda session, args, sn: session.read_resource(args["uri"]), _render_read_resource, required="uri")
_make_list_prompts_handler = _make_utility_handler(
    "prompts/list", "list_prompts",
    lambda session, args, sn: _core._paginate_full_list(session.list_prompts, "prompts", sn), _render_prompt_list)
_make_get_prompt_handler = _make_utility_handler(
    "prompts/get", "get_prompt",
    lambda session, args, sn: session.get_prompt(args["name"], arguments=args.get("arguments", {})),
    _render_get_prompt, required="name")


def _make_check_fn(server_name: str, registration_home: Optional[str] = None):
    """Connection-alive check; lazy (schema-cache registered) servers count as available."""
    def _check() -> bool:
        state_key = _core._server_state_key(server_name, registration_home)
        with _core._lock:
            server = _core._servers.get(state_key)
            return ((server is not None and (server.session is not None or server._is_recycled_stdio()))
                    or state_key in _core._lazy_server_configs)
    return _check
