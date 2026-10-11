"""Regression for adapter#450: registry-created live views survive task teardown."""

import json
import os
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
def task_browser(monkeypatch, request):
    # The repository's autouse fixture supplies a fresh HERMES_HOME per case.
    options = getattr(request, "param", {})
    base_url = options.get("base_url", "https://api.browserbase.com")
    project_id = options.get("project_id", "test-only-project")
    home = get_hermes_home()
    (home / "config.yaml").write_text(
        "browser:\n  cloud_provider: browserbase\n  headed: false\n"
        "  auto_local_for_private_urls: false\n  record_sessions: false\n"
    )
    # Synthetic credentials also let the real janitor re-enter its owner's scope.
    (home / ".env").write_text(
        f"BROWSERBASE_API_KEY=test-only-key\nBROWSERBASE_PROJECT_ID={project_id}\n"
        f"BROWSERBASE_BASE_URL={base_url}\n"
    )
    monkeypatch.setenv("BROWSERBASE_API_KEY", "test-only-key")
    monkeypatch.setenv("BROWSERBASE_PROJECT_ID", project_id)
    monkeypatch.setenv("BROWSERBASE_BASE_URL", base_url)
    clock = [time.time()]
    monkeypatch.setattr(lifecycle.time, "time", lambda: clock[0])
    created, debugged, released, commands = [], [], [], []
    http_calls = []
    release_status = [200]
    url = "https://93.184.216.34/"  # Public IP literal: URL safety needs no DNS.

    def http_request(_client, method, url, **kwargs):
        http_calls.append((method.upper(), url, kwargs.get("json")))
        status = 200
        endpoint = url
        root = f"{base_url}/v1/sessions"
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
            status = release_status[0]
            payload = {"code": "browser_unauthorized"} if status == 403 else {}
        else:
            raise AssertionError(f"Unexpected HTTP request: {method} {endpoint}")
        response = requests.Response()
        response.status_code = status
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
        if options.get("navigate", True):
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
            http_calls=http_calls,
            release_status=release_status,
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


@pytest.mark.parametrize(
    "task_browser",
    [{}, {"base_url": "https://broker.example/browserbase", "project_id": "evaos:c:hermes:a"}],
    indirect=True,
    ids=["direct", "brokered"],
)
def test_release_closes_held_session_exactly_once(task_browser):
    browser = task_browser
    browser.dispatch("browser_live_view")
    assert browser.task_id in bt._live_view_hold_until

    result = browser.dispatch("browser_live_view", {"release": True})

    assert (result["released"], result["status"]) == (True, "released")
    assert browser.released == browser.created and len(browser.released) == 1
    base = browser.http_calls[-1][1].rsplit("/v1/sessions/", 1)[0]
    assert browser.http_calls[-1] == (
        "POST",
        f"{base}/v1/sessions/{browser.created[0]}",
        {"projectId": os.environ["BROWSERBASE_PROJECT_ID"], "status": "REQUEST_RELEASE"},
    )
    for registry_map in (bt._active_sessions, bt._live_view_hold_until, bt._reaping_sessions):
        assert browser.task_id not in registry_map
    browser.agent._cleanup_task_resources(browser.task_id)
    assert len(browser.released) == 1


@pytest.mark.parametrize(
    ("task_browser", "case"),
    [({"navigate": False}, "no_session"), ({}, "provider_403"), ({}, "already_reaping")],
    indirect=["task_browser"],
)
def test_release_never_fails_the_turn_or_invites_escalation(task_browser, case):
    browser = task_browser
    if case != "no_session":
        browser.dispatch("browser_live_view")
    before = len(browser.http_calls)
    if case == "provider_403":
        browser.release_status[0] = 403
    if case == "already_reaping":
        with bt._cleanup_lock:
            bt._reaping_sessions.add(browser.task_id)
    try:
        result = browser.dispatch("browser_live_view", {"release": True})
    finally:
        if case == "already_reaping":
            with bt._cleanup_lock:
                bt._reaping_sessions.discard(browser.task_id)

    assert result["success"] is True and result["released"] is False
    assert browser.task_id not in bt._live_view_hold_until
    if case == "provider_403":
        assert result["status"] == "release_not_confirmed"
        assert browser.task_id not in bt._active_sessions
        assert "do not contact support" in result["instruction"]
    else:
        assert result["status"] == "no_active_session"
        assert len(browser.http_calls) == before
