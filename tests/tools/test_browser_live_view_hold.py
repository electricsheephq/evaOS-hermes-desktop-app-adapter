"""Regression for adapter#450: registry-created live views survive task teardown."""

import json
import time
from types import SimpleNamespace

import pytest
import requests

from hermes_constants import get_hermes_home
from run_agent import AIAgent
from tools import browser_live_view  # noqa: F401 — register the real handler
from tools import browser_tool as bt
from tools import browser_tool_lifecycle as lifecycle
from tools import browser_tool_session as sessions
from tools.registry import registry


@pytest.fixture
def task_browser(monkeypatch):
    # The repository's autouse fixture supplies a fresh HERMES_HOME per case.
    home = get_hermes_home()
    (home / "config.yaml").write_text(
        "browser:\n  cloud_provider: browserbase\n  headed: false\n"
        "  auto_local_for_private_urls: false\n  record_sessions: false\n"
    )
    # Synthetic credentials also let the real janitor re-enter its owner's scope.
    (home / ".env").write_text(
        "BROWSERBASE_API_KEY=test-only-key\nBROWSERBASE_PROJECT_ID=test-only-project\n"
    )
    monkeypatch.setenv("BROWSERBASE_API_KEY", "test-only-key")
    monkeypatch.setenv("BROWSERBASE_PROJECT_ID", "test-only-project")
    clock = [time.time()]
    monkeypatch.setattr(lifecycle.time, "time", lambda: clock[0])
    created, debugged, released, commands = [], [], [], []
    url = "https://93.184.216.34/"  # Public IP literal: URL safety needs no DNS.

    def http_request(_client, method, url, **kwargs):
        endpoint = url
        root = "https://api.browserbase.com/v1/sessions"
        if method.upper() == "POST" and endpoint == root:
            session_id = f"provider-session-{len(created) + 1}"
            created.append(session_id)
            # The fake command runner needs no CDP transport or supervisor socket.
            payload = {"id": session_id, "connectUrl": ""}
        elif method.upper() == "GET" and endpoint.endswith("/debug"):
            session_id = endpoint.removeprefix(root + "/").removesuffix("/debug")
            assert endpoint == f"{root}/{session_id}/debug" and session_id in created
            debugged.append(session_id)
            payload = {"liveViewUrl": f"https://watch.example/{session_id}"}
        elif method.upper() == "POST" and endpoint.startswith(root + "/"):
            session_id = endpoint.removeprefix(root + "/")
            assert session_id in created
            assert kwargs["json"]["status"] == "REQUEST_RELEASE"
            released.append(session_id)
            payload = {}
        else:
            raise AssertionError(f"Unexpected HTTP request: {method} {endpoint}")
        response = requests.Response()
        response.status_code = 200
        response._content = json.dumps(payload).encode()
        return response

    def command_runner(task_id, command, args=None, **kwargs):
        # Keep the session lookup performed by the real driver; fake only execution.
        info = (
            bt._active_sessions[task_id]
            if command == "close"
            else sessions._get_session_info(task_id)
        )
        commands.append((command, info["bb_session_id"]))
        data = {
            "open": {
                "url": args[0] if command == "open" else url,
                "title": "Test page",
            },
            "snapshot": {"snapshot": '- heading "Test page"', "refs": {}},
            "eval": url,
            "close": {},
        }
        assert command in data
        return {"success": True, "data": data[command]}

    monkeypatch.setattr(requests.sessions.Session, "request", http_request)
    monkeypatch.setattr(sessions, "_run_browser_command", command_runner)
    agent = object.__new__(AIAgent)  # Real cleanup methods, without model/client setup.
    agent.verbose_logging = True
    agent._process_owner_task_ids = ()
    task_id = "task-hold"

    def dispatch(name, args=None):
        result = json.loads(registry.dispatch(name, args or {}, task_id=task_id))
        assert result.get("success") is True, result
        return result

    try:
        dispatch("browser_navigate", {"url": url})
        # Exercise the real startup, then stop the worker before advancing test time.
        lifecycle._stop_browser_cleanup_thread()
        assert len(created) == 1
        yield SimpleNamespace(
            agent=agent,
            task_id=task_id,
            dispatch=dispatch,
            url=url,
            clock=clock,
            created=created,
            debugged=debugged,
            released=released,
            commands=commands,
        )
    finally:
        lifecycle._stop_browser_cleanup_thread()
        lifecycle.cleanup_all_browsers()


def test_live_view_survives_turn_and_agent_cleanup_and_reuses_session(task_browser):
    browser = task_browser
    browser.dispatch("browser_live_view")
    assert browser.debugged == browser.created

    for cleanup in (
        browser.agent._cleanup_task_resources,
        browser.agent._close_task_resources,
    ):
        cleanup(browser.task_id)
        assert browser.released == []
        before = len(browser.commands)
        browser.dispatch("browser_snapshot")
        browser.dispatch("browser_navigate", {"url": browser.url})
        assert browser.created == browser.debugged  # No second provider session.
        assert all(sid == browser.created[0] for _, sid in browser.commands[before:])
        assert all(command != "close" for command, _ in browser.commands)


@pytest.mark.parametrize(
    "live_view", [False, True], ids=["no-live-view", "expired-hold"]
)
def test_unheld_or_expired_idle_session_is_released(task_browser, live_view):
    browser = task_browser
    if live_view:
        result = browser.dispatch("browser_live_view")
        browser.agent._cleanup_task_resources(browser.task_id)
        assert browser.released == []
        browser.clock[0] += (
            result["min_hold_seconds"] + bt.BROWSER_SESSION_INACTIVITY_TIMEOUT + 1
        )
        lifecycle._cleanup_inactive_browser_sessions()
    else:
        browser.agent._cleanup_task_resources(browser.task_id)

    assert browser.released == browser.created
    # Teardown evicts the provider identity: the next real dispatch must create anew.
    browser.dispatch("browser_navigate", {"url": browser.url})
    assert len(browser.created) == 2
    assert browser.created[1] != browser.released[0]
    assert browser.commands[-1][1] == browser.created[1]
