import json
import logging

import pytest

import model_tools
import tools.browser_live_view as live_view
import tools.browser_tool as browser_tool
import tools.browser_tool_lifecycle as browser_lifecycle
from plugins.browser._common import CloudBrowserAPIError
from tools.registry import registry


class _FakeBrowserbase:
    name = "browserbase"

    def __init__(self, result="https://watch.example/session"):
        self.result = result
        self.seen = []

    def get_live_view_url(self, session_id):
        self.seen.append(session_id)
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


@pytest.fixture
def existing_named_session(monkeypatch):
    monkeypatch.setattr(
        browser_tool,
        "_active_sessions",
        {"bu-named-research": {"bb_session_id": "provider-session-1"}},
    )
    monkeypatch.setattr(browser_tool, "_session_last_activity", {"bu-named-research": 123.0})


def test_named_session_returns_link_without_logging_it(
    monkeypatch, existing_named_session, caplog
):
    provider = _FakeBrowserbase()
    monkeypatch.setattr("tools.browser_tool_cloud._get_cloud_provider", lambda: provider)
    monkeypatch.setattr(live_view.time, "time", lambda: 1_000.0)

    with caplog.at_level(logging.DEBUG):
        result = json.loads(live_view.browser_live_view(session="research", task_id="task-1"))

    assert result["success"] is True
    assert result["live_view_url"] == "https://watch.example/session"
    assert result["min_hold_seconds"] >= 900
    assert "type into the remote page themselves" in result["instruction"]
    assert provider.seen == ["provider-session-1"]
    assert result["live_view_url"] not in caplog.text
    assert browser_tool._session_last_activity["bu-named-research"] == 1_900.0

    monkeypatch.setattr(browser_lifecycle.time, "time", lambda: 1_300.0)
    monkeypatch.setattr(
        browser_lifecycle, "cleanup_browser", lambda task_id: pytest.fail(task_id)
    )
    browser_lifecycle._cleanup_inactive_browser_sessions()


@pytest.mark.parametrize(
    "status,code,retryable",
    [
        (429, "browser_capacity", True),
        (503, "browser_unavailable", True),
    ],
)
def test_provider_error_codes_are_typed(
    monkeypatch, existing_named_session, status, code, retryable
):
    error = CloudBrowserAPIError(
        f"debug request failed (code: {code})",
        status_code=status,
        code=code,
    )
    monkeypatch.setattr(
        "tools.browser_tool_cloud._get_cloud_provider",
        lambda: _FakeBrowserbase(error),
    )

    result = json.loads(live_view.browser_live_view(session="research"))

    assert result["code"] == code
    assert result["retryable"] is retryable
    assert "https://" not in result["error"]
    assert browser_tool._session_last_activity["bu-named-research"] == 123.0


def test_missing_provider_session_is_evicted(monkeypatch, existing_named_session):
    error = CloudBrowserAPIError(
        "debug request failed (code: browser_session_not_found)",
        status_code=404,
        code="browser_session_not_found",
    )
    provider = _FakeBrowserbase(error)
    monkeypatch.setattr(
        "tools.browser_tool_cloud._get_cloud_provider",
        lambda: provider,
    )

    first = json.loads(live_view.browser_live_view(session="research"))

    assert first["code"] == "browser_session_not_found"
    assert first["retryable"] is False
    assert "bu-named-research" not in browser_tool._active_sessions
    assert "bu-named-research" not in browser_tool._session_last_activity

    second = json.loads(live_view.browser_live_view(session="research"))

    assert second["code"] == "browser_session_not_found"
    assert "No active Browserbase session" in second["error"]
    assert provider.seen == ["provider-session-1"]


def test_missing_named_session_does_not_create_one(monkeypatch):
    provider = _FakeBrowserbase()
    monkeypatch.setattr("tools.browser_tool_cloud._get_cloud_provider", lambda: provider)
    monkeypatch.setattr(browser_tool, "_active_sessions", {})

    result = json.loads(live_view.browser_live_view(session="not-started"))

    assert result["code"] == "browser_session_not_found"
    assert provider.seen == []
    assert browser_tool._active_sessions == {}


def test_tool_absent_for_provider_without_live_view(monkeypatch):
    monkeypatch.setattr("tools.browser_tool_cloud._get_cloud_provider", lambda: object())
    entry = registry.get_entry("browser_live_view")
    assert entry is not None
    assert live_view.check_browser_live_view_requirements() is False
    monkeypatch.setattr(entry, "check_fn", lambda: False)

    definitions = model_tools.get_tool_definitions(
        enabled_toolsets=["browser", "terminal"], quiet_mode=False
    )

    assert "browser_live_view" not in {item["function"]["name"] for item in definitions}


def test_schema_explains_human_takeover():
    description = live_view.BROWSER_LIVE_VIEW_SCHEMA["description"]
    assert "login, MFA, or payment" in description
    assert "user types into the remote page themselves" in description
    assert "kept open for at least 15 minutes" in description
