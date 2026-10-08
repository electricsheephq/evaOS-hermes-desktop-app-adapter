import json
import logging

import pytest
import requests

import model_tools
import tools.browser_live_view as live_view
import tools.browser_tool as browser_tool
import tools.browser_tool_lifecycle as browser_lifecycle
from plugins.browser._common import CloudBrowserAPIError, _response_error_code
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


def test_browser_activity_does_not_cancel_live_view_hold(
    monkeypatch, existing_named_session
):
    provider = _FakeBrowserbase()
    monkeypatch.setattr("tools.browser_tool_cloud._get_cloud_provider", lambda: provider)
    monkeypatch.setattr(live_view.time, "time", lambda: 1_000.0)

    result = json.loads(live_view.browser_live_view(session="research", task_id="task-1"))
    assert result["success"] is True
    assert browser_tool._session_last_activity["bu-named-research"] == 1_900.0

    monkeypatch.setattr(browser_lifecycle.time, "time", lambda: 1_100.0)
    browser_lifecycle._update_session_activity("bu-named-research")
    assert browser_tool._session_last_activity["bu-named-research"] == 1_900.0

    browser_tool._session_last_activity["bu-named-research"] = 1_000.0
    browser_lifecycle._update_session_activity("bu-named-research")
    assert browser_tool._session_last_activity["bu-named-research"] == 1_100.0


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


def test_provider_failure_removes_temporary_hold_when_activity_was_absent(
    monkeypatch, existing_named_session
):
    error = CloudBrowserAPIError(
        "debug request failed (code: browser_unavailable)",
        status_code=503,
        code="browser_unavailable",
    )
    browser_tool._session_last_activity.clear()
    monkeypatch.setattr(live_view.time, "time", lambda: 1_000.0)

    class _RaisingProvider(_FakeBrowserbase):
        def get_live_view_url(self, session_id):
            assert browser_tool._session_last_activity["bu-named-research"] == 1_900.0
            raise error

    monkeypatch.setattr(
        "tools.browser_tool_cloud._get_cloud_provider", lambda: _RaisingProvider()
    )

    result = json.loads(live_view.browser_live_view(session="research"))

    assert result["code"] == "browser_unavailable"
    assert "bu-named-research" not in browser_tool._session_last_activity


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
    supervisor = object()
    browser_tool._active_sessions["bu-named-research"]["cdp_supervisor"] = supervisor
    teardown_calls = []

    def fake_teardown(key):
        assert browser_tool._active_sessions[key]["cdp_supervisor"] is supervisor
        teardown_calls.append(key)
        browser_tool._active_sessions.pop(key, None)
        browser_tool._session_last_activity.pop(key, None)

    monkeypatch.setattr(browser_lifecycle, "_cleanup_single_browser_session", fake_teardown)

    first = json.loads(live_view.browser_live_view(session="research"))

    assert first["code"] == "browser_session_not_found"
    assert first["retryable"] is False
    assert teardown_calls == ["bu-named-research"]
    assert "bu-named-research" not in browser_tool._active_sessions
    assert "bu-named-research" not in browser_tool._session_last_activity

    second = json.loads(live_view.browser_live_view(session="research"))

    assert second["code"] == "browser_session_not_found"
    assert "No active Browserbase session" in second["error"]
    assert provider.seen == ["provider-session-1"]


def test_http_404_from_provider_evicts_missing_session(
    monkeypatch, existing_named_session
):
    response = requests.Response()
    response.status_code = 404
    response._content = b'{"statusCode":404,"error":"Not Found"}'
    code = _response_error_code(response)
    error = CloudBrowserAPIError(
        f"debug request failed (code: {code})",
        status_code=response.status_code,
        code=code,
    )
    monkeypatch.setattr(
        "tools.browser_tool_cloud._get_cloud_provider",
        lambda: _FakeBrowserbase(error),
    )

    result = json.loads(live_view.browser_live_view(session="research"))

    assert code == "http_404"
    assert result["code"] == "http_404"
    assert result["retryable"] is False
    assert result["error"] == "The Browserbase session no longer exists."
    assert "bu-named-research" not in browser_tool._active_sessions
    assert "bu-named-research" not in browser_tool._session_last_activity


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


@pytest.mark.parametrize(
    "page_urls,selector,provider_kind,selected_index,matched",
    [
        (["about:blank", "https://example.com/"], "", "browserbase", 1, None),
        (["https://example.com/", "about:blank#blocked"], "", "browserbase", 0, None),
        (["https://example.com/", "about:blank?blocked=1#blocked"], "", "browserbase", 0, None),
        (["https://example.com/", "about:blank?blocked=1"], "", "browserbase", 0, None),
        (["https://example.com/docs", "https://example.com/"], "DOCS", "browserbase", 0, True),
        (["https://example.com/docs", "https://example.com/"], "missing", "browserbase", 1, False),
        (["", "about:blank", "about:newtab", "chrome://newtab/", "chrome://new-tab-page/"], "", "browserbase", None, None),
        (["https://example.com/"], "example", "narrow", 0, None),
        (["https://example.com/"], "example", "default", 0, None),
        (["https://example.com/docs", "https://example.com/"], "DOCS", "kwargs", 0, True),
        (["https://example.com/"], "example", "uninspectable", 0, None),
        (["https://example.com/"], "example", "positional-only", 0, None),
    ],
)
def test_debug_page_selection_through_tool_dispatch(
    monkeypatch, tmp_path, existing_named_session, caplog,
    page_urls, selector, provider_kind, selected_index, matched,
):
    """Regression for #451: dispatch selects usable pages without breaking old providers."""
    from unittest.mock import Mock

    from agent.browser_provider import BrowserProvider
    from plugins.browser.browserbase.provider import BrowserbaseBrowserProvider

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("BROWSERBASE_API_KEY", "synthetic-key")
    monkeypatch.setenv("BROWSERBASE_PROJECT_ID", "synthetic-project")
    monkeypatch.delenv("BROWSERBASE_BASE_URL", raising=False)
    pages = [
        {"url": url, "title": f"Tab {index}", "debuggerFullscreenUrl": f"https://watch.example/page-{index}"}
        for index, url in enumerate(page_urls)
    ]
    session_url = "https://watch.example/session"
    response = requests.Response()
    response.status_code = 200
    response._content = json.dumps({"liveViewUrl": session_url, "pages": pages}).encode()
    get = Mock(return_value=response)
    monkeypatch.setattr(requests, "get", get)

    class NarrowProvider(BrowserbaseBrowserProvider):
        def get_live_view(self, session_id):
            return {"url": super().get_live_view(session_id)["url"]}

    class KwargsProvider(BrowserbaseBrowserProvider):
        def get_live_view(self, session_id, **kwargs):
            return super().get_live_view(session_id, page=kwargs.get("page", ""))

    class PositionalOnlyProvider(BrowserbaseBrowserProvider):
        def get_live_view(self, session_id, page="", /):
            assert page == ""
            return {"url": super().get_live_view(session_id)["url"]}

    providers = {
        "browserbase": BrowserbaseBrowserProvider,
        "narrow": NarrowProvider,
        "kwargs": KwargsProvider,
        "uninspectable": NarrowProvider,
        "positional-only": PositionalOnlyProvider,
    }
    if provider_kind == "default":
        class UrlOnlyProvider(BrowserbaseBrowserProvider):
            get_live_view = BrowserProvider.get_live_view

            def get_live_view_url(self, session_id):
                return BrowserbaseBrowserProvider.get_live_view(self, session_id)["url"]

        provider = UrlOnlyProvider()
    else:
        provider = providers[provider_kind]()
    if provider_kind == "uninspectable":
        monkeypatch.setattr(NarrowProvider.get_live_view, "__signature__", "unavailable", raising=False)
    monkeypatch.setattr("tools.browser_tool_cloud._get_cloud_provider", lambda: provider)
    monkeypatch.setattr(live_view.time, "time", lambda: 1_000.0)

    with caplog.at_level(logging.INFO):
        result = json.loads(registry.dispatch(
            "browser_live_view", {"session": "research", "page": selector}, task_id="task-1"
        ))

    assert result["success"] is True
    expected_url = session_url if selected_index is None else pages[selected_index]["debuggerFullscreenUrl"]
    assert result["live_view_url"] == expected_url
    if provider_kind in {"browserbase", "kwargs"}:
        metadata = pages[0] if selected_index is None else pages[selected_index]
        assert (result["page_url"], result["page_title"], result["page_count"]) == (
            metadata["url"], metadata["title"], len(pages),
        )
    if selector and matched is not None:
        assert result["page_matched"] is matched
        assert ("No page matched" in result["instruction"]) is (not matched)
    elif selector:
        assert "page_matched" not in result
        assert "does not support selecting a page" in result["instruction"]
    assert result["min_hold_seconds"] >= 900
    assert browser_tool._session_last_activity["bu-named-research"] == 1_900.0
    get.assert_called_once_with(
        "https://api.browserbase.com/v1/sessions/provider-session-1/debug",
        headers={"Content-Type": "application/json", "X-BB-API-Key": "synthetic-key"},
        timeout=10,
    )
    assert expected_url not in caplog.text
