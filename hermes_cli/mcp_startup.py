"""Shared CLI/TUI-safe helpers for background MCP discovery."""

from __future__ import annotations

import contextvars
import threading
from contextlib import nullcontext
from pathlib import Path
from typing import Optional

from hermes_constants import get_hermes_home_override, reset_hermes_home_override, set_hermes_home_override

_mcp_discovery_lock = threading.Lock()
_mcp_discovery_started = False
_mcp_discovery_thread: Optional[threading.Thread] = None
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


def _any_mcp_connected() -> bool:
    from tools.mcp_tool_discovery import get_mcp_status

    return any(entry.get("connected") for entry in (get_mcp_status() or []))


def start_background_mcp_discovery(*, logger, thread_name: str) -> None:
    """Spawn one background MCP discovery thread for the active scope.

    If the first run exits without connecting any server (e.g. startup cancellation / OOM restart),
    later calls may retry instead of pinning the process in "already started" with zero MCP tools.
    Multiplex serves keep this state per effective profile home; single-profile callers retain the
    historical process-wide slot.
    """
    global _mcp_discovery_started, _mcp_discovery_thread

    scope_key = _discovery_scope_key()
    # A shared serve may host profiles with no MCP configuration. Avoid creating
    # empty per-profile slots while still probing lazily on each session.
    if scope_key is not None and not _has_configured_mcp_servers():
        return
    with _mcp_discovery_lock:
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
            if scope_key is None:
                _mcp_discovery_started = False
                _mcp_discovery_thread = None
            else:
                _mcp_discovery_started_scopes.discard(scope_key)
                _mcp_discovery_threads.pop(scope_key, None)

        if scope_key is None:
            _mcp_discovery_started = True
        else:
            _mcp_discovery_started_scopes.add(scope_key)
        if scope_key is None and not _has_configured_mcp_servers():
            return

        # Re-install the caller's context-local HERMES_HOME override (multi-profile dashboard/desktop
        # backends) inside the thread: ContextVars don't propagate into bare threads, so a session
        # switched to profile X would otherwise discover the LAUNCH profile's mcp_servers.
        # The config gate above already runs on the caller's thread, so it sees the same override. See
        # #67605.
        home_override = get_hermes_home_override()

        def _discover() -> None:
            token = set_hermes_home_override(home_override)
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
                reset_hermes_home_override(token)
                with _mcp_discovery_lock:
                    global _mcp_discovery_thread
                    if scope_key is None:
                        _mcp_discovery_thread = None
                    else:
                        _mcp_discovery_threads.pop(scope_key, None)

        caller_context = contextvars.copy_context()
        thread = threading.Thread(
            target=lambda: caller_context.run(_discover), name=thread_name, daemon=True,
        )
        if scope_key is None:
            _mcp_discovery_thread = thread
        else:
            _mcp_discovery_threads[scope_key] = thread
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


def defer_background_mcp_discovery(*, logger, thread_name: str, delay: float) -> None:
    """Arm ``start_background_mcp_discovery`` to run ``delay`` seconds from now.

    Used by the Desktop ``serve`` backend after its socket is announced: the thread's first act is
    the ~350ms ``mcp`` SDK import, which would hold the GIL against the renderer's connect + first
    hydration reads (or the web_server import) if started earlier.
    """
    global _mcp_discovery_deferred
    with _mcp_discovery_lock:
        if _mcp_discovery_started or _mcp_discovery_deferred is not None:
            return

        def _fire() -> None:
            global _mcp_discovery_deferred
            with _mcp_discovery_lock:
                _mcp_discovery_deferred = None
            start_background_mcp_discovery(logger=logger, thread_name=thread_name)

        timer = threading.Timer(delay, _fire)
        timer.daemon = True
        timer.name = f"{thread_name}-deferred"
        _mcp_discovery_deferred = timer
        timer.start()


def _start_deferred_mcp_discovery_now() -> None:
    """Run an armed deferred start immediately (idempotent, thread-safe)."""
    with _mcp_discovery_lock:
        timer = _mcp_discovery_deferred
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
    _start_deferred_mcp_discovery_now()
    thread = _current_discovery_thread()
    if thread is None or not thread.is_alive():
        return
    thread.join(timeout=_resolve_discovery_timeout(timeout, single_query=single_query))


def mcp_discovery_in_flight() -> bool:
    """True if THIS module's discovery thread is still running.

    Mirrors ``tui_gateway.entry.mcp_discovery_in_flight``; surfaces that start discovery here
    (desktop, dashboard sidecar) populate this thread, so the late-refresh scheduler consults both.

    Those processes populate THIS module's ``_mcp_discovery_thread``, not ``tui_gateway.entry``'s, so the
    late-refresh scheduler must consult both to decide whether a slow server's tools are still pending (see
    #51587).
    """
    thread = _current_discovery_thread()
    return thread is not None and thread.is_alive()


def join_mcp_discovery(timeout: "float | None" = None) -> bool:
    """Block up to ``timeout`` for THIS module's discovery; True once complete, False if still
    running. For the off-critical-path late-refresh waiter (accepts a long wait, reports outcome)."""
    thread = _current_discovery_thread()
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
