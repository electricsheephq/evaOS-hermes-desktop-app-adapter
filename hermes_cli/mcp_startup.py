"""Shared CLI/TUI-safe helpers for background MCP discovery."""

from __future__ import annotations

import threading
from contextlib import nullcontext
from contextvars import copy_context
<<<<<<< HEAD
from pathlib import Path
from typing import Optional
||||||| 939e45c91d
from typing import Optional
=======
from typing import Dict, Optional, Set

from hermes_constants import hermes_home_key
>>>>>>> f97608f178

_mcp_discovery_lock = threading.Lock()
# Discovery slot per profile home (``hermes_home_key()`` follows the context-local HERMES_HOME
# override): a shared Desktop/dashboard backend serving several profiles runs one discovery per
# profile instead of the first profile to build an agent claiming the slot for everybody (#67605).
# A single-profile process has exactly one key, so behaviour is the old single-slot form.
_mcp_discovery_started: Set[str] = set()
_mcp_discovery_thread: Dict[str, threading.Thread] = {}
_mcp_discovery_deferred: Optional[threading.Timer] = None
# A multiplex serve owns one lazy discovery slot per effective profile home.
# The legacy globals above remain the only slot outside multiplex mode.
_mcp_discovery_started_scopes: set[str] = set()
_mcp_discovery_threads: dict[str, threading.Thread] = {}
# Process-wide MCP server-name allowlist derived from ``-t/--toolsets``.
# ``None`` = no filter (spawn every configured server). Set once at CLI
# startup by ``set_mcp_server_filter`` and honored by every discovery path
# in this module (inline, background, deferred), so a ``-t terminal``
# oneshot never cold-starts MCP subprocesses it cannot use.
_mcp_server_filter: Optional[list[str]] = None


def _discovery_scope_key() -> Optional[str]:
    """Return the current multiplex profile identity, else the legacy slot."""
    try:
        from agent.secret_scope import is_multiplex_active

        if not is_multiplex_active():
            return None
        from hermes_constants import get_hermes_home

        return str(Path(get_hermes_home()).expanduser().resolve())
    except Exception:
        # Fail closed to the historical process slot when multiplex identity
        # cannot be resolved; never invent a shared profile key.
        return None


def _current_discovery_thread() -> Optional[threading.Thread]:
    scope_key = _discovery_scope_key()
    if scope_key is None:
        return _mcp_discovery_thread
    return _mcp_discovery_threads.get(scope_key)


def _any_mcp_connected_for_scope(scope_key: Optional[str]) -> bool:
    """Return whether a live MCP server belongs to the active profile scope."""
    if scope_key is None:
        return _any_mcp_connected()
    try:
        from tools import mcp_tool

        with mcp_tool._lock:
            return any(
                getattr(server, "session", None) is not None
                and mcp_tool._server_scope_keys.get(name) == scope_key
                for name, server in mcp_tool._servers.items()
            )
    except Exception:
        # A missing/changed state seam must not treat another profile's
        # connection as proof for this profile.
        return False


def set_mcp_server_filter(toolsets: object) -> Optional[list[str]]:
    """Derive the MCP spawn allowlist from a ``-t/--toolsets`` value.

    Built-in toolset names in the list are harmless (they never match a
    configured ``mcp_servers`` key). ``all``/``*`` or an empty/absent value
    clears the filter. Returns the stored list for logging/tests.
    """
    global _mcp_server_filter
    names: list[str] = []
    if isinstance(toolsets, str):
        names = [t.strip() for t in toolsets.split(",") if t.strip()]
    elif isinstance(toolsets, (list, tuple, set)):
        for item in toolsets:
            names.extend(t.strip() for t in str(item).split(",") if t.strip())
    if not names or "all" in names or "*" in names:
        _mcp_server_filter = None
    else:
        _mcp_server_filter = names
    return _mcp_server_filter


def get_mcp_server_filter() -> Optional[list[str]]:
    return _mcp_server_filter


def _has_configured_mcp_servers() -> bool:
    """Cheap config probe so non-MCP users avoid importing the MCP stack."""
    try:
        from hermes_cli import managed_scope
        from hermes_cli.config import read_raw_config

        raw_config = managed_scope.apply_managed_overlay(read_raw_config() or {})
        if isinstance(raw_config.get("mcp_servers"), dict) and raw_config["mcp_servers"]:
            return True
        from hermes_cli.agent_plugins import has_enabled_agent_plugin_mcp

        return has_enabled_agent_plugin_mcp(raw_config)
    except Exception:
        return True  # conservative: still try discovery in the background; startup can't block


def _discovery_registered_servers(status) -> bool:
    """True when a discovery run left servers usable: a live session OR a lazy registration.

    A ``lazy: true`` server never connects until first use, so an all-lazy config (the
    memory-saving setup the feature exists for) looked like a run that achieved nothing:
    the zero-connected warning fired on every startup and the retry path re-ran discovery
    on every later call (#111717).
    """
    return any(entry.get("connected") or entry.get("status") == "lazy" for entry in (status or []))


def _any_mcp_connected() -> bool:
    from tools.mcp_tool_discovery import get_mcp_status

    return _discovery_registered_servers(get_mcp_status() or [])


def start_background_mcp_discovery(*, logger, thread_name: str) -> None:
<<<<<<< HEAD
    """Spawn one background MCP discovery thread for the active scope.
||||||| 939e45c91d
    """Spawn one shared background MCP discovery thread for this process.
=======
    """Spawn one background MCP discovery thread per profile home.
>>>>>>> f97608f178

    If the first run exits without connecting any server (e.g. startup cancellation / OOM restart),
<<<<<<< HEAD
    later calls may retry instead of pinning the process in "already started" with zero MCP tools.
    Multiplex serves keep this state per effective profile home; single-profile callers retain the
    historical process-wide slot.
||||||| 939e45c91d
    later calls may retry instead of pinning the process in "already started" with zero MCP tools.
=======
    later calls may retry instead of pinning the profile in "already started" with zero MCP tools.
>>>>>>> f97608f178
    """
<<<<<<< HEAD
    global _mcp_discovery_started, _mcp_discovery_thread

    scope_key = _discovery_scope_key()
    # A shared serve may host profiles with no MCP configuration. Avoid creating
    # empty per-profile slots while still probing lazily on each session.
    if scope_key is not None and not _has_configured_mcp_servers():
        return
||||||| 939e45c91d
    global _mcp_discovery_started, _mcp_discovery_thread

=======
    home_key = hermes_home_key()
>>>>>>> f97608f178
    with _mcp_discovery_lock:
<<<<<<< HEAD
        started = (
            _mcp_discovery_started
            if scope_key is None
            else scope_key in _mcp_discovery_started_scopes
        )
        thread = (
            _mcp_discovery_thread
            if scope_key is None
            else _mcp_discovery_threads.get(scope_key)
        )
        if started:
||||||| 939e45c91d
        if _mcp_discovery_started:
            thread = _mcp_discovery_thread
=======
        if home_key in _mcp_discovery_started:
            thread = _mcp_discovery_thread.get(home_key)
>>>>>>> f97608f178
            if thread is not None and thread.is_alive():
                return
            try:
                if _any_mcp_connected_for_scope(scope_key):
                    return
            except Exception:
                return
            logger.warning(
                "Background MCP discovery previously exited with no connected "
                "servers; retrying discovery thread"
            )
<<<<<<< HEAD
            if scope_key is None:
                _mcp_discovery_started = False
                _mcp_discovery_thread = None
            else:
                _mcp_discovery_started_scopes.discard(scope_key)
                _mcp_discovery_threads.pop(scope_key, None)
||||||| 939e45c91d
            _mcp_discovery_started = False
            _mcp_discovery_thread = None
=======
            _mcp_discovery_started.discard(home_key)
            _mcp_discovery_thread.pop(home_key, None)
>>>>>>> f97608f178

<<<<<<< HEAD
        if scope_key is None:
            _mcp_discovery_started = True
        else:
            _mcp_discovery_started_scopes.add(scope_key)
        if scope_key is None and not _has_configured_mcp_servers():
||||||| 939e45c91d
        _mcp_discovery_started = True
        if not _has_configured_mcp_servers():
=======
        _mcp_discovery_started.add(home_key)
        if not _has_configured_mcp_servers():
>>>>>>> f97608f178
            return

        # Bare threads start from an empty context: run discovery under a copy of the caller's, so
        # the context-local HERMES_HOME override (multi-profile dashboard/desktop backends, #67605)
        # AND the profile's secret scope reach it. Without the scope a session switched to profile
        # X would discover the LAUNCH profile's mcp_servers, and ``${TOKEN}`` interpolation / the
        # stdio child env would fail closed (multiplex) or resolve the launch profile's value.
        # The config gate above already runs on the caller's thread, so it sees the same context.
        def _discover() -> None:
            try:
                _discover_mcp_tools_without_interactive_oauth()
                try:
                    if not _any_mcp_connected_for_scope(scope_key):
                        logger.warning("Background MCP discovery completed with zero connected servers")
                except Exception:
                    logger.debug("Failed to inspect MCP status after background discovery", exc_info=True)
            except Exception:
                logger.debug("Background MCP tool discovery failed", exc_info=True)
            finally:
                with _mcp_discovery_lock:
<<<<<<< HEAD
                    global _mcp_discovery_thread
                    if scope_key is None:
                        _mcp_discovery_thread = None
                    else:
                        _mcp_discovery_threads.pop(scope_key, None)
||||||| 939e45c91d
                    global _mcp_discovery_thread
                    _mcp_discovery_thread = None
=======
                    _mcp_discovery_thread.pop(home_key, None)
>>>>>>> f97608f178

<<<<<<< HEAD
        caller_context = copy_context()
        thread = threading.Thread(
            target=lambda: caller_context.run(_discover), name=thread_name, daemon=True,
        )
        if scope_key is None:
            _mcp_discovery_thread = thread
        else:
            _mcp_discovery_threads[scope_key] = thread
||||||| 939e45c91d
        thread = threading.Thread(target=copy_context().run, args=(_discover,), name=thread_name, daemon=True)
        _mcp_discovery_thread = thread
=======
        thread = threading.Thread(target=copy_context().run, args=(_discover,), name=thread_name, daemon=True)
        _mcp_discovery_thread[home_key] = thread
>>>>>>> f97608f178
        thread.start()


def _resolve_discovery_timeout(explicit: "float | None", *, single_query: bool = False) -> float:
    """Resolve the MCP discovery wait bound: explicit arg > config.yaml > ``DEFAULT_CONFIG``.

    Lazy and fail-safe: a missing/invalid value or broken config falls back to a short bound so
    startup can never hang or crash.
    """
    if explicit is not None:
        return explicit
    key = "mcp_single_query_discovery_timeout" if single_query else "mcp_discovery_timeout"
    fallback = 15.0 if single_query else 1.5
    try:
        from hermes_cli.config import load_config, DEFAULT_CONFIG

        default = float(DEFAULT_CONFIG.get(key, fallback))
    except Exception:
        return fallback
    try:
        val = float((load_config() or {}).get(key, default))
        return val if val > 0 else default
    except Exception:
        return default


def _discover_mcp_tools_without_interactive_oauth() -> None:
    """Run MCP discovery without letting OAuth read from the user's stdin."""
    try:
        from tools.mcp_oauth import suppress_interactive_oauth
    except Exception:
        suppress_interactive_oauth = nullcontext

    with suppress_interactive_oauth():
        from tools.mcp_tool_discovery import discover_mcp_tools

        # Only pass the kwarg when a filter is set: many tests (and any
        # out-of-tree caller) stub discover_mcp_tools with a zero-arg
        # callable, and the unfiltered call shape is unchanged.
        if _mcp_server_filter is None:
            discover_mcp_tools()
        else:
            discover_mcp_tools(allowed_mcp_names=_mcp_server_filter)


def defer_background_mcp_discovery(*, logger, thread_name: str, delay: float | None) -> None:
    """Arm ``start_background_mcp_discovery`` to run ``delay`` seconds from now.

    Used by the Desktop ``serve`` backend after its socket is announced: the thread's first act is
    the ~350ms ``mcp`` SDK import, which would hold the GIL against the renderer's connect + first
    hydration reads (or the web_server import) if started earlier.

    ``delay=None`` arms without a clock: the standalone dashboard fires it from the first ``/api/ws``
    client (``start_deferred_mcp_discovery_now``) or the first agent build (``wait_for_mcp_discovery``),
    so an idle, unvisited dashboard never spawns the configured stdio MCP servers (#58733).
    """
    global _mcp_discovery_deferred
    with _mcp_discovery_lock:
        if hermes_home_key() in _mcp_discovery_started or _mcp_discovery_deferred is not None:
            return

        def _fire() -> None:
            global _mcp_discovery_deferred
            with _mcp_discovery_lock:
                _mcp_discovery_deferred = None
            start_background_mcp_discovery(logger=logger, thread_name=thread_name)

        # ``None`` builds the Timer only as the holder of ``_fire``; it is never started and
        # ``start_deferred_mcp_discovery_now`` runs ``timer.function()`` directly.
        timer = threading.Timer(0 if delay is None else delay, _fire)
        timer.daemon = True
        timer.name = f"{thread_name}-deferred"
        _mcp_discovery_deferred = timer
        if delay is not None:
            timer.start()


def start_deferred_mcp_discovery_now() -> None:
    """Run an armed deferred start immediately (idempotent, thread-safe)."""
    global _mcp_discovery_deferred
    with _mcp_discovery_lock:  # take the slot atomically: two racing first clients fire once
        timer, _mcp_discovery_deferred = _mcp_discovery_deferred, None
    if timer is None:
        return
    timer.cancel()
    timer.function()


def wait_for_mcp_discovery(timeout: "float | None" = None, *, single_query: bool = False) -> None:
    """Wait for background MCP discovery before the first tool snapshot.

    ``join`` returns the instant discovery completes, so this only blocks for a still-pending
    server's real connect time. ``single_query`` uses ``mcp_single_query_discovery_timeout``
    (15s vs 1.5s) because one-shot sessions have no second turn to recover.
    """
<<<<<<< HEAD
    _start_deferred_mcp_discovery_now()
    thread = _current_discovery_thread()
||||||| 939e45c91d
    _start_deferred_mcp_discovery_now()
    thread = _mcp_discovery_thread
=======
    start_deferred_mcp_discovery_now()
    thread = _current_home_thread()
>>>>>>> f97608f178
    if thread is None or not thread.is_alive():
        return
    thread.join(timeout=_resolve_discovery_timeout(timeout, single_query=single_query))


def _current_home_thread() -> Optional[threading.Thread]:
    """Discovery thread for the profile home the caller is scoped to, if any."""
    return _mcp_discovery_thread.get(hermes_home_key())


def mcp_discovery_in_flight() -> bool:
    """True if THIS module's discovery thread (for the current profile home) is still running.

    Mirrors ``tui_gateway.entry.mcp_discovery_in_flight``; surfaces that start discovery here
    (desktop, dashboard sidecar) populate this thread, so the late-refresh scheduler consults both.

    Those processes populate THIS module's ``_mcp_discovery_thread``, not ``tui_gateway.entry``'s, so the
    late-refresh scheduler must consult both to decide whether a slow server's tools are still pending (see
    #51587).
    """
<<<<<<< HEAD
    thread = _current_discovery_thread()
||||||| 939e45c91d
    thread = _mcp_discovery_thread
=======
    thread = _current_home_thread()
>>>>>>> f97608f178
    return thread is not None and thread.is_alive()


def join_mcp_discovery(timeout: "float | None" = None) -> bool:
    """Block up to ``timeout`` for THIS module's discovery; True once complete, False if still
    running. For the off-critical-path late-refresh waiter (accepts a long wait, reports outcome)."""
<<<<<<< HEAD
    thread = _current_discovery_thread()
||||||| 939e45c91d
    thread = _mcp_discovery_thread
=======
    thread = _current_home_thread()
>>>>>>> f97608f178
    if thread is None:
        return True
    thread.join(timeout=timeout)
    return not thread.is_alive()


def ensure_mcp_discovery_before_agent_build(
    *,
    logger,
    timeout: "float | None" = None,
    single_query: bool = False,
    thread_name: str = "cli-mcp-discovery") -> None:
    """Give configured MCP tools a bounded chance to register before AIAgent.

    Non-interactive first turns (``chat -q``, ``hermes -z``) can construct ``AIAgent`` before any
    path started discovery, and ``wait_for_mcp_discovery()`` only joins an existing thread — so
    start discovery if needed, then wait up to the configured bound.
    """
    try:
        start_background_mcp_discovery(logger=logger, thread_name=thread_name)
        wait_for_mcp_discovery(timeout=timeout, single_query=single_query)
    except Exception:
        logger.debug("MCP discovery readiness check failed before agent build", exc_info=True)
