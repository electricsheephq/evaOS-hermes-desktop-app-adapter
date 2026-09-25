"""Read-only live-view link for an already-running cloud browser session."""

from __future__ import annotations

import time
from typing import Any, Dict, Optional

from tools.browser_use_cli import _SESSION_RE, _backend_cache_key
from tools.registry import registry, tool_error, tool_result

LIVE_VIEW_HOLD_SECONDS = 900


def _live_view_provider():
    try:
        from tools.browser_tool_cloud import _get_cloud_provider

        provider = _get_cloud_provider()
    except Exception:
        return None
    return provider if callable(getattr(provider, "get_live_view_url", None)) else None


def check_browser_live_view_requirements() -> bool:
    """Expose the tool only when the active browser provider implements live view."""
    return _live_view_provider() is not None


def _existing_session(task_id: Optional[str], session: str) -> Dict[str, Any]:
    """Copy an existing Browser Use session record without creating or refreshing it."""
    from tools import browser_tool

    key = _backend_cache_key(task_id, session)
    with browser_tool._cleanup_lock:
        info = browser_tool._active_sessions.get(key)
        return dict(info) if isinstance(info, dict) else {}


def browser_live_view(session: str = "", task_id: Optional[str] = None) -> str:
    """Return a secure live-view URL and keep its session open for at least 15 minutes."""
    if session and not _SESSION_RE.match(session):
        return tool_error(
            f"Invalid session name {session!r}: use 1-64 letters, digits, dashes, or underscores.",
            code="invalid_browser_session",
            retryable=False,
        )
    provider = _live_view_provider()
    if provider is None:
        return tool_error(
            "The active browser provider does not support live view.",
            code="browser_live_view_unsupported",
            retryable=False,
        )
    info = _existing_session(task_id, session)
    provider_session_id = str(info.get("bb_session_id") or "")
    if not provider_session_id:
        return tool_error(
            "No active Browserbase session was found for that session name; start it with a browser tool first.",
            code="browser_session_not_found",
            retryable=False,
        )
    from tools import browser_tool

    key = _backend_cache_key(task_id, session)
    with browser_tool._cleanup_lock:
        current = browser_tool._active_sessions.get(key)
        if (
            not isinstance(current, dict)
            or str(current.get("bb_session_id") or "") != provider_session_id
        ):
            return tool_error(
                "No active Browserbase session was found for that session name; start it with a browser tool first.",
                code="browser_session_not_found",
                retryable=False,
            )
        had_previous_activity = key in browser_tool._session_last_activity
        previous_activity = browser_tool._session_last_activity.get(key)
        held_until = max(
            browser_tool._session_last_activity.get(key, 0.0),
            time.time() + LIVE_VIEW_HOLD_SECONDS,
        )
        browser_tool._session_last_activity[key] = held_until

    def restore_activity() -> None:
        with browser_tool._cleanup_lock:
            current = browser_tool._active_sessions.get(key)
            current_activity = browser_tool._session_last_activity.get(key)
            if current_activity != held_until:
                return
            if (
                isinstance(current, dict)
                and str(current.get("bb_session_id") or "") == provider_session_id
                and had_previous_activity
            ):
                browser_tool._session_last_activity[key] = previous_activity
            else:
                browser_tool._session_last_activity.pop(key, None)

    try:
        url = str(provider.get_live_view_url(provider_session_id) or "")
    except Exception as exc:
        restore_activity()
        code = str(getattr(exc, "code", "browser_live_view_failed"))
        status = getattr(exc, "status_code", None)
        if code == "browser_session_not_found":
            from tools import browser_tool_lifecycle

            with browser_tool._cleanup_lock:
                current = browser_tool._active_sessions.get(key)
                should_cleanup = (
                    isinstance(current, dict)
                    and str(current.get("bb_session_id") or "") == provider_session_id
                )
            if should_cleanup:
                browser_tool_lifecycle._cleanup_single_browser_session(key)
        message = {
            "browser_session_not_found": "The Browserbase session no longer exists.",
            "browser_capacity": "browser capacity reached — retry shortly",
            "browser_unavailable": "Browserbase live view is temporarily unavailable — retry shortly.",
        }.get(code, f"Browserbase live view failed (code: {code}).")
        return tool_error(
            message,
            code=code,
            retryable=status == 429 or (isinstance(status, int) and status >= 500),
        )
    if not url.startswith("https://"):
        restore_activity()
        return tool_error(
            "Browserbase returned no secure live-view URL.",
            code="browser_invalid_response",
            retryable=False,
        )
    return tool_result(
        success=True,
        live_view_url=url,
        min_hold_seconds=LIVE_VIEW_HOLD_SECONDS,
        instruction="Send this link to the user. They type into the remote page themselves.",
    )


BROWSER_LIVE_VIEW_SCHEMA = {
    "name": "browser_live_view",
    "description": (
        "Get a live-view link for an existing Browserbase session without creating a browser. Use when the "
        "user asks to watch, or when a step needs the human to act in the page (login, MFA, or payment). "
        "Send the link and say plainly that the user types into the remote page themselves. The session is "
        "kept open for at least 15 minutes after the link is issued; call this tool again to extend the hold."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "session": {
                "type": "string",
                "description": "Existing named browser session. Reuse the same name passed to the other browser tools; omit for the current task session.",
            }
        },
    },
}


registry.register(
    name="browser_live_view",
    toolset="browser",
    schema=BROWSER_LIVE_VIEW_SCHEMA,
    handler=lambda args, **kw: browser_live_view(
        session=args.get("session", "") or "",
        task_id=kw.get("task_id"),
    ),
    check_fn=check_browser_live_view_requirements,
    emoji="📺",
)
