#!/usr/bin/env python3
"""Bridge desktop-only tools to Hermes-desktop renderer events.

The preview pane, pane focus, and friends live in the desktop renderer, so
desktop-gated tools reach them through an emitter the desktop ``tui_gateway``
installs at session start via :func:`set_emitter`. Everywhere else it stays
``None`` and the tools report "desktop only". Routing keys off
``HERMES_UI_SESSION_ID`` so the event lands on the window that owns the turn
(``_emit``/``write_json`` is ``_stdout_lock``-guarded, so emitting from the
tool's thread is safe).
"""

from typing import Callable, Optional

from gateway.session_context import get_session_env

# (sid, event, payload) sink, installed by the desktop gateway.
_emit: Optional[Callable[[str, str, dict], None]] = None
# (sid, event) -> structured JSON error or None. The gateway owns negotiation;
# tools merely consult this resolver immediately before touching the renderer.
_protocol_error: Optional[Callable[[str, str], Optional[str]]] = None


def set_emitter(fn: Optional[Callable[[str, str, dict], None]]) -> None:
    """Install (or clear) the renderer-event sink. Called by the desktop gateway."""
    global _emit
    _emit = fn


def set_protocol_resolver(
    fn: Optional[Callable[[str, str], Optional[str]]],
) -> None:
    """Install (or clear) the session-scoped Desktop protocol guard."""
    global _protocol_error
    _protocol_error = fn


def protocol_error(event: str) -> Optional[str]:
    """Return a structured capability error for the current session, if any."""
    resolver = _protocol_error
    if resolver is None:
        return None
    return resolver(get_session_env("HERMES_UI_SESSION_ID", ""), event)


def available() -> bool:
    """True when running under the desktop app (an emitter is wired)."""
    return _emit is not None


def emit(event: str, payload: dict) -> bool:
    """Route ``event`` to the window that owns the current turn.

    Returns ``False`` when no emitter is wired (i.e. not the desktop app)."""
    fn = _emit
    if fn is None:
        return False
    sid = get_session_env("HERMES_UI_SESSION_ID", "")
    resolver = _protocol_error
    if resolver is not None and resolver(sid, event) is not None:
        return False
    fn(sid, event, payload)
    return True
