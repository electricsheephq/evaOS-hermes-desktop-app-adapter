"""Managed browser execs keep their own Chromium alive without sharing harness daemons."""
import contextvars
import json
import logging
import subprocess
import threading
import time

import pytest

import tools.browser_use_cli as bu_cli
from tools import browser_tool as bt
from tools import browser_tool_cloud as bt_cloud
from tools import browser_tool_session as bt_session
from tests.tools.test_browser_use_cli import (
    _clean_env, _fake_cli, _fake_managed_chromium, _fake_supervisor_registry,
)  # noqa: F401 — reuse the hermetic CLI/browser fixtures


def _managed_route(monkeypatch):
    monkeypatch.setattr("tools.browser_tool_cdp._get_cdp_override", lambda: "")
    monkeypatch.setattr(bt_cloud, "_get_cloud_provider", lambda: None)
    monkeypatch.setattr(bu_cli, "_read_browser_cfg", lambda: {})
    monkeypatch.setattr("tools.browser_tool_lightpanda_fallback._using_lightpanda_engine", lambda: False)


def test_long_exec_keeps_managed_browser_alive(tmp_path, monkeypatch, _fake_managed_chromium):
    _managed_route(monkeypatch)
    scope = contextvars.ContextVar("keepalive_test_scope", default=None)
    scope.set("exec-scope")
    beats = []
    threads = []

    def ping(key, timeout):
        beats.append((key, timeout, scope.get()))
        threads.append(threading.current_thread())
        return bt_session._run_browser_command(key, "get", ["cdp-url"], timeout=timeout)

    monkeypatch.setattr(bt_session, "_keepalive_managed_browser", ping, raising=False)
    monkeypatch.setattr(bu_cli, "_keepalive_period_s", lambda: 0.2, raising=False)
    cli = _fake_cli(tmp_path, "cat > /dev/null\nsleep 1.2\necho done\n")
    monkeypatch.setattr(bu_cli, "_find_cli", lambda: [cli])
    assert json.loads(bu_cli.browser_exec("print(1)", task_id="task-long"))["success"] is True
    key = bu_cli._backend_cache_key("task-long")
    assert len(beats) >= 3
    assert all(beat == (key, bt._get_open_command_timeout(first_open=True), "exec-scope") for beat in beats)
    assert _fake_managed_chromium.count((key, "get", ("cdp-url",))) == len(beats) + 1
    assert all(thread.daemon and not thread.is_alive() for thread in threads)
    count = len(beats)
    time.sleep(0.4)
    assert len(beats) == count


def test_unnamed_managed_calls_get_a_per_task_daemon(tmp_path, monkeypatch):
    _managed_route(monkeypatch)
    cli = _fake_cli(tmp_path, 'cat > /dev/null\necho "bu:${BU_NAME:-default} sentinel:${_HERMES_BU_MANAGED_KEY:-unset}"\n')
    monkeypatch.setattr(bu_cli, "_find_cli", lambda: [cli])

    def name(task):
        result = json.loads(bu_cli.browser_exec("print(1)", task_id=task))
        assert result["success"] is True
        assert "sentinel:unset" in result["output"]
        return result["output"].split("bu:")[1].split()[0]

    a, b, a2 = name("task-a"), name("task-b"), name("task-a")
    assert "default" not in (a, b)
    assert a != b and a == a2
    assert all(value.startswith("t-") and len(value) == 22 for value in (a, b))


@pytest.mark.parametrize("route", ["override", "cloud", "local"])
def test_non_managed_route_starts_no_keepalive(route, tmp_path, monkeypatch):
    _managed_route(monkeypatch)
    if route == "override":
        monkeypatch.setattr("tools.browser_tool_cdp._get_cdp_override", lambda: "wss://browser.example/cdp")
    elif route == "cloud":
        monkeypatch.setattr(bt_cloud, "_get_cloud_provider", lambda: object())
        monkeypatch.setattr(bt_session, "_get_session_info", lambda key: {"cdp_url": "wss://browser.example/cdp"})
    else:
        monkeypatch.setattr(bu_cli, "_real_profile_consented", lambda: True)
        monkeypatch.setattr("tools.browser_tool_real_profile._real_profile_cdp",
                            lambda: ("wss://browser.example/cdp", None))
    # A non-managed route must never even create the keepalive worker.
    monkeypatch.setattr("threading.Thread", lambda **kw: pytest.fail("unexpected keepalive thread"))
    cli = _fake_cli(tmp_path, "cat > /dev/null\necho done\n")
    monkeypatch.setattr(bu_cli, "_find_cli", lambda: [cli])
    assert json.loads(bu_cli.browser_exec("print(1)", local=route == "local"))["success"] is True


@pytest.mark.parametrize("error", [RuntimeError("wss://browser.example/private"),
                                   subprocess.TimeoutExpired("private-code", 120)])
def test_keepalive_error_does_not_fail_exec(error, tmp_path, monkeypatch, caplog):
    _managed_route(monkeypatch)
    calls = []

    def ping(key, timeout):
        calls.append(key)
        raise error

    monkeypatch.setattr(bt_session, "_keepalive_managed_browser", ping, raising=False)
    monkeypatch.setattr(bu_cli, "_keepalive_period_s", lambda: 0.1, raising=False)
    cli = _fake_cli(tmp_path, "cat > /dev/null\nsleep 0.5\necho done\n")
    monkeypatch.setattr(bu_cli, "_find_cli", lambda: [cli])
    with caplog.at_level(logging.DEBUG, logger=bu_cli.__name__):
        result = json.loads(bu_cli.browser_exec("print(1)", task_id="task-errors"))
    assert result["success"] is True
    assert calls
    messages = [record.getMessage() for record in caplog.records if record.name == bu_cli.__name__]
    assert "Managed browser keepalive failed" in messages
    assert all("browser.example/private" not in message and "private-code" not in message for message in messages)


@pytest.mark.parametrize("outcome", ["timeout", "nonzero"])
def test_keepalive_failure_never_recycles_existing_browser(outcome, tmp_path, monkeypatch):
    session = {"session_name": "managed-test", "features": {"local": True}}
    monkeypatch.setitem(bt._active_sessions, "task-existing", session)
    monkeypatch.setattr(bt_session, "_prepare_session_socket_dir", lambda name: str(tmp_path))
    monkeypatch.setattr(bt_session, "_agent_browser_command_env", lambda path: {})
    monkeypatch.setattr(bt_session, "_apply_chromium_sandbox_args", lambda env: None)
    monkeypatch.setattr(bt_session._install, "_find_agent_browser", lambda: "agent-browser")
    monkeypatch.setattr(bt_session, "_agent_browser_argv", lambda cmd: [cmd])
    for name in ("_get_session_info", "_handle_browser_command_timeout", "_recycle_local_session"):
        monkeypatch.setattr(bt_session, name, lambda *a, **kw: pytest.fail("keepalive entered browser recovery"))
    killed = []
    timeouts = []

    class Client:
        returncode = 101

        def wait(self, timeout=None):
            timeouts.append(timeout)
            if outcome == "timeout" and not killed:
                raise subprocess.TimeoutExpired("get", timeout)

        def kill(self):
            killed.append(True)

    def spawn(argv, env, socket_dir, tag):
        assert argv == ["agent-browser", "--session", "managed-test", "--json", "get", "cdp-url"]
        return Client()

    monkeypatch.setattr(bt_session, "_popen_agent_browser", spawn)
    timeout = bt._get_open_command_timeout(first_open=True)
    if outcome == "timeout":
        with pytest.raises(subprocess.TimeoutExpired):
            bt_session._keepalive_managed_browser("task-existing", timeout)
        assert killed == [True]
    else:
        assert bt_session._keepalive_managed_browser("task-existing", timeout) == {"success": False}
        assert not killed
    assert timeouts[0] == timeout
    assert bt._active_sessions["task-existing"] is session
    assert "task-existing" in bt._session_last_activity
