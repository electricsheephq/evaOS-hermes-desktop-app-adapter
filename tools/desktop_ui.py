#!/usr/bin/env python3
"""Bridge desktop-only tools to Hermes-desktop renderer events.

The desktop ``tui_gateway`` installs an emitter via :func:`set_emitter`; elsewhere it
stays ``None`` and tools report "desktop only". Routing keys off ``HERMES_UI_SESSION_ID``
so the event lands on the window that owns the turn (the sink is lock-guarded).
"""

import json
from typing import Callable, Optional

from gateway.session_context import get_session_env
from tools.registry import tool_error

# (sid, event, payload) sink, installed by the desktop gateway.
_emit: Optional[Callable[[str, str, dict], None]] = None
# (sid, event) -> structured JSON error or None.  The gateway owns negotiation;
# tools consult this immediately before touching the renderer.
_protocol_error: Optional[Callable[[str, str], Optional[str]]] = None
# (sid) -> negotiated protocol level.  This is only used for dynamic schemas;
# authorization remains in ``_protocol_error`` at dispatch time.
_protocol_level: Optional[Callable[[str], Optional[int]]] = None


def set_emitter(fn: Optional[Callable[[str, str, dict], None]]) -> None:
    """Install (or clear) the renderer-event sink. Called by the desktop gateway."""
    global _emit
    _emit = fn


def set_protocol_resolver(
    fn: Optional[Callable[[str, str], Optional[str]]],
) -> None:
    """Install (or clear) the session-scoped Desktop protocol guard."""
    global _protocol_error, _protocol_level
    _protocol_error = fn
    if fn is None:
        _protocol_level = None


def set_protocol_level_resolver(
    fn: Optional[Callable[[str], Optional[int]]],
) -> None:
    """Install (or clear) the negotiated-level reader used by schemas."""
    global _protocol_level
    _protocol_level = fn


def protocol_error(event: str) -> Optional[str]:
    """Return a structured capability error for the current session, if any."""
    resolver = _protocol_error
    if resolver is None:
        return None
    sid = get_session_env("HERMES_UI_SESSION_ID", "") or get_session_env("HERMES_SESSION_ID", "")
    return resolver(sid, event)


def protocol_level() -> Optional[int]:
    """Return the negotiated level for the current session when the gateway wired it."""
    resolver = _protocol_level
    try:
        sid = get_session_env("HERMES_UI_SESSION_ID", "") or get_session_env("HERMES_SESSION_ID", "")
        if resolver is not None:
            value = resolver(sid)
            return value if isinstance(value, int) and not isinstance(value, bool) else None
        # Keep dynamic schemas useful for lightweight integrations that only install
        # the mandatory dispatch guard.  The guard's structured response carries the
        # negotiated level, so this is an observation only; dispatch still rechecks
        # ``protocol_error`` immediately before emitting.
        guard = _protocol_error
        if guard is None:
            return None
        raw_error = guard(sid, "tip.show")
        if raw_error is None:
            return 3
        details = json.loads(raw_error)
        value = details.get("negotiated_protocol") if isinstance(details, dict) else None
    except Exception:
        return None
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def available() -> bool:
    """True when running under the desktop app (an emitter is wired)."""
    return _emit is not None


def user_enabled(setting: str, default: bool) -> bool:
    """Read a desktop Appearance switch from ``display.<setting>``. The renderer mirrors
    these toggles onto the CONNECTED gateway's config, so this is the user's real answer
    for local/SSH/URL/cloud gateways alike; ``check_fn``s use it to withdraw a tool from
    the schema. Unreadable config -> ``default`` so a shipped-on feature does not vanish
    on a transient read error."""
    try:
        from hermes_cli.config import load_config_readonly
        display = load_config_readonly().get("display")
    except Exception:
        return default
    if not isinstance(display, dict) or setting not in display:
        return default
    return bool(display.get(setting))


def emit(event: str, payload: dict) -> bool:
    """Route ``event`` to the window owning the current turn; False when no emitter."""
    if _emit is None or protocol_error(event) is not None:
        return False
    _emit(get_session_env("HERMES_UI_SESSION_ID", ""), event, payload)
    return True


def emit_or_error(event: str, payload: dict, fail_prefix: str, desktop_only: str, result: dict) -> str:
    """Emit ``event``; ``tool_error`` text on failure (``fail_prefix`` + exception, or
    ``desktop_only`` when no emitter), else ``result`` as JSON. Calls ``emit`` via the
    module attribute so tests can patch it."""
    if error := protocol_error(event):
        return error
    try:
        ok = emit(event, payload)
    except Exception as exc:
        return tool_error(f"{fail_prefix}{exc}")
    return json.dumps(result, ensure_ascii=False) if ok else tool_error(desktop_only)


def passthrough_json(raw) -> str:
    """Desktop answers with a JSON object; pass it through, else wrap the raw text."""
    try:
        return json.dumps(json.loads(raw), ensure_ascii=False)
    except (TypeError, ValueError):
        return json.dumps({"text": str(raw)}, ensure_ascii=False)
