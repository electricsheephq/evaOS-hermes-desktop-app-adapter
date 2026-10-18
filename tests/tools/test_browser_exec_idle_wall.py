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


def test_keepalive_exit_does_not_wait_for_blocked_heartbeat(monkeypatch):
    entered = threading.Event()
    release = threading.Event()
    workers = []

    def ping(key, timeout):
        workers.append(threading.current_thread())
        entered.set()
        assert release.wait(8), "test heartbeat was never released"
        return {"success": True}

    monkeypatch.setattr(bt_session, "_keepalive_managed_browser", ping)
    monkeypatch.setattr(bu_cli, "_keepalive_period_s", lambda: 0.01)
    # Fail finitely on the old unbounded join, even when context exit blocks.
    watchdog = threading.Timer(6, release.set)
    watchdog.start()
    try:
        with bu_cli._managed_browser_keepalive("task-blocked"):
            assert entered.wait(2)
            start = time.monotonic()
        assert time.monotonic() - start < 4
        assert workers[0].is_alive(), "in-flight heartbeat must finish independently"
    finally:
        release.set()
        watchdog.cancel()
        watchdog.join(2)
        for worker in workers:
            worker.join(2)
    assert len(workers) == 1
    assert not workers[0].is_alive()


@pytest.mark.parametrize("list_output,list_exit,refresh", [
    ('{"success":true,"data":{"sessions":["managed-test"]}}', 0, True),
    ('{"success":true,"data":{"sessions":["another-session"]}}', 0, False),
    ('{"success":true,"data":{"sessions":[]}}', 0, False),
    ('not json', 0, True),
    ('{"success":true,"data":{"sessions":[{}]}}', 0, True),
    ('{"success":true,"data":{"sessions":[]}}', 101, True),
], ids=["listed", "absent", "empty", "unparseable", "unknown-shape", "nonzero"])
def test_keepalive_guards_refresh_without_recovery(list_output, list_exit, refresh, tmp_path, monkeypatch):
    session = {"session_name": "managed-test"}
    monkeypatch.setitem(bt._active_sessions, "task-existing", session)
    monkeypatch.setattr(bt_session, "_prepare_session_socket_dir", lambda name: str(tmp_path))
    monkeypatch.setattr(bt_session, "_agent_browser_command_env", lambda path: {})
    monkeypatch.setattr(bt_session, "_apply_chromium_sandbox_args", lambda env: None)
    monkeypatch.setattr(bt_session._install, "_find_agent_browser", lambda: "agent-browser")
    monkeypatch.setattr(bt_session, "_agent_browser_argv", lambda cmd: [cmd])
    for name in ("_run_browser_command", "_get_session_info", "_handle_browser_command_timeout", "_recycle_local_session"):
        monkeypatch.setattr(bt_session, name, lambda *a, **kw: pytest.fail("keepalive entered browser recovery"))
    fenced = []
    monkeypatch.setattr(bt_session, "run_fenced", lambda info, fn: (fenced.append(info), fn())[1])
    calls, tags, waits = [], [], []

    class Client:
        def __init__(self, code):
            self.returncode = code

        def wait(self, timeout=None):
            waits.append(timeout)

    def spawn(argv, env, socket_dir, tag):
        assert argv[:4] == ["agent-browser", "--session", "managed-test", "--json"]
        calls.append(argv[4:])
        tags.append(tag)
        (tmp_path / f"_stdout_{tag}").write_text(list_output if len(calls) == 1 else "private endpoint")
        (tmp_path / f"_stderr_{tag}").write_text("")
        return Client(list_exit if len(calls) == 1 else 0)

    monkeypatch.setattr(bt_session, "_popen_agent_browser", spawn)
    result = bt_session._keepalive_managed_browser("task-existing", 7)
    assert result == ({"success": True} if refresh else {"success": False, "skipped": "session_gone"})
    assert calls == [["session", "list"]] + ([["get", "cdp-url"]] if refresh else [])
    assert waits == [7] * len(calls)
    assert len(set(tags)) == len(tags)
    assert not list(tmp_path.glob("_std*"))
    assert fenced == [session]
    assert bt._active_sessions["task-existing"] is session


@pytest.mark.parametrize("command", ["list", "refresh"])
@pytest.mark.parametrize("outcome", ["timeout", "kill-timeout", "nonzero"])
def test_keepalive_failure_never_recycles_existing_browser(command, outcome, tmp_path, monkeypatch):
    session = {"session_name": "managed-test", "features": {"local": True}}
    monkeypatch.setitem(bt._active_sessions, "task-existing", session)
    monkeypatch.setattr(bt_session, "_prepare_session_socket_dir", lambda name: str(tmp_path))
    monkeypatch.setattr(bt_session, "_agent_browser_command_env", lambda path: {})
    monkeypatch.setattr(bt_session, "_apply_chromium_sandbox_args", lambda env: None)
    monkeypatch.setattr(bt_session._install, "_find_agent_browser", lambda: "agent-browser")
    monkeypatch.setattr(bt_session, "_agent_browser_argv", lambda cmd: [cmd])
    for name in ("_run_browser_command", "_get_session_info", "_handle_browser_command_timeout", "_recycle_local_session"):
        monkeypatch.setattr(bt_session, name, lambda *a, **kw: pytest.fail("keepalive entered browser recovery"))
    killed = []
    timeouts = []
    calls = []

    class Client:
        def __init__(self, failing):
            self.failing = failing
            self.returncode = 101 if failing else 0

        def wait(self, timeout=None):
            timeouts.append(timeout)
            assert timeout is not None, "every client wait must be bounded"
            if self.failing and (outcome == "kill-timeout" or (outcome == "timeout" and not killed)):
                raise subprocess.TimeoutExpired("get", timeout)

        def kill(self):
            killed.append(True)

    def spawn(argv, env, socket_dir, tag):
        calls.append(argv[4:])
        assert argv == ["agent-browser", "--session", "managed-test", "--json"] + (
            ["session", "list"] if len(calls) == 1 else ["get", "cdp-url"])
        (tmp_path / f"_stdout_{tag}").write_text('{"success":true,"data":{"sessions":["managed-test"]}}')
        (tmp_path / f"_stderr_{tag}").write_text("")
        return Client(len(calls) == (1 if command == "list" else 2))

    monkeypatch.setattr(bt_session, "_popen_agent_browser", spawn)
    timeout = bt._get_open_command_timeout(first_open=True)
    if outcome in ("timeout", "kill-timeout"):
        with pytest.raises(subprocess.TimeoutExpired):
            bt_session._keepalive_managed_browser("task-existing", timeout)
        assert killed == [True]
        assert timeouts[-1] == 2
    else:
        assert bt_session._keepalive_managed_browser("task-existing", timeout) == {"success": command == "list"}
        assert not killed
    assert timeouts[0] == timeout
    assert not list(tmp_path.glob("_std*"))
    assert bt._active_sessions["task-existing"] is session
    assert "task-existing" in bt._session_last_activity


@pytest.mark.parametrize("headed,engine,attach,camofox", [
    (False, "auto", None, False),
    (True, "auto", None, False),
    (False, "chrome", None, False),
    (False, "auto", 9222, False),
    (True, "chrome", 9222, False),
    (False, "chrome", None, True),
    (False, "lightpanda", None, False),
], ids=["plain", "headed", "engine-pinned", "desktop-attach", "combined", "camofox", "lightpanda"])
def test_keepalive_launch_inputs_match_dispatch(headed, engine, attach, camofox, tmp_path, monkeypatch):
    session = {"session_name": "managed-parity", "features": {"local": True}}
    monkeypatch.setitem(bt._active_sessions, "task-parity", session)
    monkeypatch.setattr(bt_cloud, "_is_headed_mode", lambda: headed)
    monkeypatch.setattr(bt_cloud, "_get_browser_engine", lambda: engine)
    monkeypatch.setattr(bt, "_is_camofox_mode", lambda: camofox)
    monkeypatch.setattr(bt_session, "_bot_desktop_attach_port", lambda info: attach if info is session else None)
    monkeypatch.setattr(bt_session, "_ensure_screen_for_headed_chromium", lambda: None)
    monkeypatch.setattr(bt_session, "_prepare_session_socket_dir", lambda name: str(tmp_path))
    monkeypatch.setattr(bt_session, "_agent_browser_command_env", lambda path: {"profile": "synthetic"})
    monkeypatch.setattr(bt_session, "_needs_chromium_sandbox_bypass", lambda: True)
    monkeypatch.setattr(bt_session._install, "_find_agent_browser", lambda: "agent-browser")
    monkeypatch.setattr(bt_session, "run_fenced", lambda info, fn: fn())
    calls = []

    class Client:
        returncode = 0

        def wait(self, timeout=None):
            assert timeout == 7

    def spawn(argv, env, socket_dir, tag, stdin_payload=None):
        calls.append((argv, env.copy()))
        output = ({"success": True, "data": {"sessions": [session["session_name"]]}}
                  if argv[-2:] == ["session", "list"] else {"success": True})
        (tmp_path / f"_stdout_{tag}").write_text(json.dumps(output))
        (tmp_path / f"_stderr_{tag}").write_text("")
        return Client()

    monkeypatch.setattr(bt_session, "_popen_agent_browser", spawn)
    assert bt_session._dispatch_browser_command(
        "task-parity", session, "agent-browser", "get", ["cdp-url"], 7, None
    ) == (engine, {"success": True})
    dispatched = calls.pop()
    result = bt_session._keepalive_managed_browser("task-parity", 7)
    if engine == "lightpanda":
        assert result == {"success": False, "skipped": "lightpanda"}
        assert calls == []
    else:
        assert result == {"success": True}
        assert len(calls) == 2
        assert calls[0][0][-2:] == ["session", "list"]
        assert calls[1] == dispatched
        assert dispatched[1]["AGENT_BROWSER_ARGS"] == ",".join(bt_session.CHROMIUM_SANDBOX_BYPASS_ARGS)
    assert not list(tmp_path.glob("_std*"))
