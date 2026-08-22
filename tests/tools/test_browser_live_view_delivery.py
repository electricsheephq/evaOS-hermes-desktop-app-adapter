"""Browser sessions expose one executor-only private handoff notice."""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor

import tools.browser_tool as browser_tool


def test_browser_navigate_surfaces_live_view_once(monkeypatch):
    session = {
        "session_name": "cloud_session",
        "bb_session_id": "session_test",
        "cdp_url": "wss://connect.browserbase.test/session",
        "user_handoff": {"url": "https://live.browserbase.test/session"},
        "features": {"basic_stealth": True, "proxies": True},
    }

    monkeypatch.setattr(browser_tool, "_navigation_session_key", lambda task_id, url: task_id)
    monkeypatch.setattr(browser_tool, "_get_session_info", lambda task_id: session)
    monkeypatch.setattr(browser_tool, "_maybe_start_recording", lambda task_id: None)
    monkeypatch.setattr(browser_tool, "_is_local_backend", lambda: False)
    monkeypatch.setattr(browser_tool, "_allow_private_urls", lambda: False)
    monkeypatch.setattr(browser_tool, "_is_safe_url", lambda url: True)
    monkeypatch.setattr(browser_tool, "_is_always_blocked_url", lambda url: False)
    monkeypatch.setattr(browser_tool, "_sensitive_query_param_name", lambda url: None)
    monkeypatch.setattr(browser_tool, "_is_camofox_mode", lambda: False)
    monkeypatch.setattr(browser_tool, "check_website_access", lambda url: None)

    def fake_browser_command(task_id, command, args, timeout=None):
        if command == "open":
            return {
                "success": True,
                "data": {"title": "Example", "url": "https://example.com/"},
            }
        if command == "snapshot":
            return {"success": True, "data": {"snapshot": "Example", "refs": {}}}
        raise AssertionError(f"unexpected command: {command}")

    monkeypatch.setattr(browser_tool, "_run_browser_command", fake_browser_command)

    first_raw = browser_tool.browser_navigate("https://example.com", "task-a")
    second_raw = browser_tool.browser_navigate("https://example.com", "task-a")
    first = json.loads(first_raw)
    second = json.loads(second_raw)

    assert getattr(first_raw, "_hermes_private_notices")[0]["text"].startswith(
        "Browser Live View: https://live.browserbase.test/session"
    )
    assert "cdp_url" not in first
    assert "live.browserbase.test" not in repr(first)
    assert not hasattr(second_raw, "_hermes_private_notices")
    assert session["_user_handoff_announced"] is True


def test_new_session_can_surface_its_own_live_view(monkeypatch):
    first_session = {"user_handoff": {"url": "https://live.browserbase.test/one"}}
    second_session = {"user_handoff": {"url": "https://live.browserbase.test/two"}}

    assert browser_tool._take_user_handoff_url(first_session) == (
        "https://live.browserbase.test/one"
    )
    assert browser_tool._take_user_handoff_url(first_session) is None
    assert browser_tool._take_user_handoff_url(second_session) == (
        "https://live.browserbase.test/two"
    )


def test_concurrent_delivery_surfaces_live_view_once():
    session = {"user_handoff": {"url": "https://live.browserbase.test/session"}}

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(
            executor.map(
                lambda _: browser_tool._take_user_handoff_url(session), range(2)
            )
        )

    assert sorted(result is None for result in results) == [False, True]
    assert [result for result in results if result is not None] == [
        "https://live.browserbase.test/session"
    ]


def test_blocked_redirect_does_not_consume_live_view(monkeypatch):
    session = {
        "user_handoff": {"url": "https://live.browserbase.test/session"},
        "_first_nav": False,
    }

    monkeypatch.setattr(browser_tool, "_navigation_session_key", lambda task_id, url: task_id)
    monkeypatch.setattr(browser_tool, "_get_session_info", lambda task_id: session)
    monkeypatch.setattr(browser_tool, "_is_local_backend", lambda: False)
    monkeypatch.setattr(browser_tool, "_allow_private_urls", lambda: False)
    monkeypatch.setattr(browser_tool, "_is_always_blocked_url", lambda url: True)
    monkeypatch.setattr(browser_tool, "_sensitive_query_param_name", lambda url: None)
    monkeypatch.setattr(browser_tool, "_is_camofox_mode", lambda: False)
    monkeypatch.setattr(browser_tool, "check_website_access", lambda url: None)
    monkeypatch.setattr(
        browser_tool,
        "_run_browser_command",
        lambda *args, **kwargs: {
            "success": True,
            "data": {
                "title": "Redirected",
                "url": "http://169.254.169.254/latest/meta-data/",
            },
        },
    )

    result = json.loads(
        browser_tool.browser_navigate("https://example.com", "task-a")
    )

    assert result["success"] is False
    assert "_hermes_private_notices" not in result
    assert "_user_handoff_announced" not in session


def test_failed_navigation_surfaces_private_handoff_once(monkeypatch):
    session = {
        "user_handoff": {"url": "https://live.browserbase.test/session"},
        "_first_nav": False,
    }

    monkeypatch.setattr(browser_tool, "_navigation_session_key", lambda task_id, url: task_id)
    monkeypatch.setattr(browser_tool, "_get_session_info", lambda task_id: session)
    monkeypatch.setattr(browser_tool, "_is_local_backend", lambda: False)
    monkeypatch.setattr(browser_tool, "_allow_private_urls", lambda: False)
    monkeypatch.setattr(browser_tool, "_is_always_blocked_url", lambda url: False)
    monkeypatch.setattr(browser_tool, "_sensitive_query_param_name", lambda url: None)
    monkeypatch.setattr(browser_tool, "_is_camofox_mode", lambda: False)
    monkeypatch.setattr(browser_tool, "check_website_access", lambda url: None)
    monkeypatch.setattr(
        browser_tool,
        "_run_browser_command",
        lambda *args, **kwargs: {"success": False, "error": "navigation failed"},
    )

    first_raw = browser_tool.browser_navigate("https://example.com", "task-a")
    second_raw = browser_tool.browser_navigate("https://example.com", "task-a")
    first = json.loads(first_raw)

    assert first["success"] is False
    assert getattr(first_raw, "_hermes_private_notices")[0]["key"] == (
        "browser.live_view"
    )
    assert "live.browserbase.test" not in repr(first)
    assert not hasattr(second_raw, "_hermes_private_notices")
