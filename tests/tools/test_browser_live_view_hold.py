"""Regression for adapter#450: a task browser's live view survives turn/agent cleanup."""

import json
import logging
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from agent.chat_completion_helpers import cleanup_task_resources
from agent.client_lifecycle import ClientLifecycleMixin
from tools import browser_live_view as live_view
from tools import browser_tool as bt
from tools import browser_tool_lifecycle as lifecycle
from tools import browser_tool_session as sessions


@pytest.fixture
def task_browser(monkeypatch):
    task_id = "task-hold"
    info = {"bb_session_id": "provider-session-1", "session_name": ""}
    provider = Mock()
    provider.get_live_view_url.return_value = "https://watch.example/session"
    for name, value in (
        ("_active_sessions", {task_id: info}),
        ("_session_last_activity", {task_id: 1000.0}),
        ("_live_view_hold_until", {}),
        ("_last_active_session_key", {task_id: task_id}),
        ("_session_owner_homes", {}),
        ("_cleanup_failures", {}),
        ("_suspect_browser_sessions", {}),
        ("_recording_sessions", set()),
    ):
        # The new state is absent on base; the behavioral probes must still run there.
        monkeypatch.setattr(bt, name, value, raising=False)
    monkeypatch.setattr(live_view.time, "time", lambda: 1000.0)
    monkeypatch.setattr("tools.browser_use_cli._served_profile_tag", lambda: "")
    monkeypatch.setattr("tools.browser_tool_cloud._get_cloud_provider", lambda: provider)
    monkeypatch.setattr("tools.browser_tool_cloud._is_headed_mode", lambda: False)
    monkeypatch.setattr("tools.browser_tool_cdp._get_cdp_override", lambda: "")
    monkeypatch.setattr("tools.browser_tool_cdp._stop_cdp_supervisor", lambda _tid: None)
    monkeypatch.setattr("tools.browser_tool_cdp._ensure_cdp_supervisor", lambda _tid: None)
    monkeypatch.setattr(bt, "_is_camofox_mode", lambda: False)
    monkeypatch.setattr(bt, "_maybe_stop_recording", lambda _tid: None)
    monkeypatch.setattr(lifecycle, "_start_browser_cleanup_thread", lambda: None)
    monkeypatch.setattr(sessions, "_run_browser_command", Mock(return_value={"success": True}))
    monkeypatch.setattr("agent.chat_completion_helpers.is_persistent_env", lambda _tid: False)
    vm_cleanup = Mock()
    computer_release = Mock()
    monkeypatch.setattr("run_agent.cleanup_vm", vm_cleanup)
    monkeypatch.setattr("tools.process_registry.process_registry.list_sessions", lambda: [])
    monkeypatch.setattr("tools.computer_use.tool.release_computer_use_session", computer_release)
    agent = SimpleNamespace(verbose_logging=True, _process_owner_task_ids=())
    return SimpleNamespace(
        task_id=task_id, info=info, provider=provider, agent=agent,
        vm_cleanup=vm_cleanup, computer_release=computer_release,
    )


def _hold(browser):
    result = json.loads(live_view.browser_live_view(task_id=browser.task_id))
    assert result["success"] is True
    return result


def test_live_view_survives_turn_cleanup_and_reuses_provider_session(task_browser, caplog):
    browser = task_browser
    result = _hold(browser)
    with caplog.at_level(logging.INFO):
        cleanup_task_resources(browser.agent, browser.task_id)

    browser.provider.close_session.assert_not_called()
    assert bt._active_sessions[browser.task_id] is browser.info
    assert bt._last_active_session_key[browser.task_id] == browser.task_id
    assert sessions._get_session_info(browser.task_id)["bb_session_id"] == browser.info["bb_session_id"]
    browser.provider.create_session.assert_not_called()
    browser.vm_cleanup.assert_called_once_with(browser.task_id)
    skip_logs = [record.getMessage() for record in caplog.records if "live-view hold" in record.getMessage()]
    assert len(skip_logs) == 1
    assert browser.task_id in skip_logs[0]
    assert str(result["min_hold_seconds"]) in skip_logs[0]
    assert result["live_view_url"] not in caplog.text


def test_expired_live_view_is_reaped_after_inactivity(task_browser, monkeypatch):
    browser = task_browser
    _hold(browser)
    until = bt._session_last_activity[browser.task_id]
    monkeypatch.setattr(lifecycle.time, "time", lambda: until + bt.BROWSER_SESSION_INACTIVITY_TIMEOUT + 1)

    lifecycle._cleanup_inactive_browser_sessions()

    browser.provider.close_session.assert_called_once_with(browser.info["bb_session_id"])
    assert browser.task_id not in bt._active_sessions
    assert browser.task_id not in bt._live_view_hold_until


def test_turn_cleanup_without_live_view_still_closes(task_browser):
    browser = task_browser
    cleanup_task_resources(browser.agent, browser.task_id)

    browser.provider.close_session.assert_called_once_with(browser.info["bb_session_id"])
    assert browser.task_id not in bt._active_sessions
    assert browser.task_id not in bt._last_active_session_key


def test_failed_live_view_leaves_no_hold_and_turn_cleanup_closes(task_browser):
    browser = task_browser
    browser.provider.get_live_view_url.side_effect = RuntimeError("provider unavailable")
    result = json.loads(live_view.browser_live_view(task_id=browser.task_id))

    assert result["code"] == "browser_live_view_failed"
    assert browser.task_id not in bt._live_view_hold_until
    assert bt._session_last_activity[browser.task_id] == 1000.0
    cleanup_task_resources(browser.agent, browser.task_id)
    browser.provider.close_session.assert_called_once_with(browser.info["bb_session_id"])


def test_live_view_survives_agent_close_and_other_cleanup_runs(task_browser):
    browser = task_browser
    _hold(browser)
    ClientLifecycleMixin._close_task_resources(browser.agent, browser.task_id)

    browser.provider.close_session.assert_not_called()
    assert bt._active_sessions[browser.task_id] is browser.info
    assert bt._last_active_session_key[browser.task_id] == browser.task_id
    browser.vm_cleanup.assert_called_once_with(browser.task_id)
    browser.computer_release.assert_called_once_with(browser.task_id)


def test_cleanup_all_closes_even_with_live_view_hold(task_browser):
    browser = task_browser
    _hold(browser)
    lifecycle.cleanup_all_browsers()

    browser.provider.close_session.assert_called_once_with(browser.info["bb_session_id"])
    assert browser.task_id not in bt._active_sessions
    assert browser.task_id not in bt._live_view_hold_until


@pytest.mark.parametrize("failure", [RuntimeError("provider unavailable"), "http://watch.example/session", ""])
def test_failed_extension_restores_previous_hold(task_browser, monkeypatch, failure):
    browser = task_browser
    _hold(browser)
    previous_hold = bt._live_view_hold_until[browser.task_id]
    monkeypatch.setattr(live_view.time, "time", lambda: 1100.0)
    if isinstance(failure, Exception):
        browser.provider.get_live_view_url.side_effect = failure
    else:
        browser.provider.get_live_view_url.return_value = failure

    result = json.loads(live_view.browser_live_view(task_id=browser.task_id))

    assert "error" in result
    assert bt._live_view_hold_until[browser.task_id] == previous_hold
    assert bt._session_last_activity[browser.task_id] == previous_hold


@pytest.mark.parametrize("sidecar_present,until,active", [(True, 1001.0, True), (True, 1000.0, False), (False, 1001.0, False)])
def test_hold_predicate_matches_cleanup_sidecar_keys(task_browser, sidecar_present, until, active):
    key = f"{task_browser.task_id}::local"
    bt._live_view_hold_until[key] = until
    if sidecar_present:
        bt._active_sessions[key] = {"bb_session_id": None}

    assert lifecycle.live_view_hold_active(task_browser.task_id) is active
    # Direct sidecar cleanup does not depend on its presence in the session map.
    assert lifecycle.live_view_hold_active(key) is (until > 1000.0)
