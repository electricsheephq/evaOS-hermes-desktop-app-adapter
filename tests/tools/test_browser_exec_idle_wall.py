"""Managed exec keepalive and task isolation invariants (PR #492)."""
import json
from pathlib import Path
import subprocess
import time

import tools.browser_use_cli as bu_cli
from tools import browser_tool as bt
from tools import browser_tool_cloud as bt_cloud
from tools import browser_tool_session as bt_session
from tools.registry import registry
from tests.tools.test_browser_use_cli import (
    _clean_env, _fake_cli, _fake_managed_chromium, _fake_supervisor_registry,
)  # noqa: F401 — reuse the hermetic CLI/browser fixtures


def _managed_route(monkeypatch):
    monkeypatch.setattr("tools.browser_tool_cdp._get_cdp_override", lambda: "")
    monkeypatch.setattr(bt_cloud, "_get_cloud_provider", lambda: None)
    monkeypatch.setattr(bu_cli, "_read_browser_cfg", lambda: {})
    monkeypatch.setattr("tools.browser_tool_lightpanda_fallback._using_lightpanda_engine", lambda: False)


def test_managed_exec_survives_idle_timeout_without_launching_unverified_sessions(tmp_path, monkeypatch):
    _managed_route(monkeypatch)
    monkeypatch.setattr(bu_cli, "_find_cli", lambda: ["browser-use"])
    monkeypatch.setattr(bu_cli, "_keepalive_period_s", lambda: 0.1, raising=False)
    monkeypatch.setattr(bt_cloud, "_get_browser_engine", lambda: "lightpanda")
    monkeypatch.setattr(bt_cloud, "_is_headed_mode", lambda: False)
    monkeypatch.setattr(bt_session, "_bot_desktop_attach_port", lambda info: None)
    monkeypatch.setattr(bt_session, "_prepare_session_socket_dir", lambda name: str(tmp_path))
    monkeypatch.setattr(bt_session, "_agent_browser_command_env", lambda path: {})
    monkeypatch.setattr(bt_session, "_apply_chromium_sandbox_args", lambda env: None)
    monkeypatch.setattr(bt_session._install, "_find_agent_browser", lambda: "agent-browser")
    monkeypatch.setattr(bt_session, "_agent_browser_argv", lambda cmd: [cmd])
    # Captured real CLI responses for both supported versions; no real browser is launched.
    fixtures = json.loads((Path(__file__).parent / "fixtures/browser_session_list.json").read_text())
    state, calls = {}, []
    idle_timeout = 2.0

    def resolve(key, command, args=None, **kwargs):
        info = {"session_name": "probe"}
        monkeypatch.setitem(bt._active_sessions, key, info)
        state.update(key=key, last_activity=time.monotonic())
        _, result = bt_session._dispatch_browser_command(
            key, info, "agent-browser", command, args or [], 7, "chrome")
        return result

    monkeypatch.setattr(bt_session, "_spawn_and_collect", lambda *args: {
        "success": True, "data": {"cdpUrl": "ws://127.0.0.1:47000/devtools/browser/probe"}})

    monkeypatch.setattr(bt_session, "_run_browser_command", resolve)

    class Client:
        def __init__(self, returncode):
            self.returncode = returncode

        def wait(self, timeout=None):
            pass

    def spawn(argv, env, socket_dir, tag):
        assert argv[argv.index("--engine") + 1] == "chrome"
        command = argv[-2:]
        calls.append(command)
        if command == ["session", "list"]:
            output, returncode = state["response"]["stdout"], state["response"]["exit"]
        else:
            assert command == ["get", "cdp-url"]
            state["last_activity"] = time.monotonic()
            output, returncode = "", 0
        (tmp_path / f"_stdout_{tag}").write_text(output)
        (tmp_path / f"_stderr_{tag}").write_text("")
        return Client(returncode)

    monkeypatch.setattr(bt_session, "_popen_agent_browser", spawn)

    def workload(cmd, code, env, timeout):
        # Model the daemon's idle wall while the harness does direct CDP work.
        end = time.monotonic() + 2.1 * idle_timeout
        while time.monotonic() < end:
            if time.monotonic() - state["last_activity"] >= idle_timeout:
                return subprocess.CompletedProcess(cmd, 1, "", "managed browser expired")
            time.sleep(0.02)
        return subprocess.CompletedProcess(cmd, 0, "done", "")

    monkeypatch.setattr(bu_cli, "_run_cli_killing_process_group", workload)
    for version, samples in fixtures.items():
        state["response"] = samples["live"]
        calls.clear()
        result = json.loads(registry.dispatch("browser_exec", {"code": "print(1)"}, task_id="task-long"))
        assert result["success"] is True, (version, result)
        assert ["get", "cdp-url"] in calls
        # After the call, an absent, failed or unknown list must never issue a launching command.
        for response in (
            samples["never-opened"], samples["closed"],
            {"exit": 0, "stdout": '{"success":true,"data":{"sessions":["other"]}}'},
            {"exit": 1, "stdout": samples["live"]["stdout"]},
            {"exit": 0, "stdout": "not json"},
            {"exit": 0, "stdout": '{"success":true,"data":{"sessions":[{}]}}'},
            {"exit": 0, "stdout": '{"success":false,"data":{"sessions":["probe"]}}'},
        ):
            state["response"] = response
            calls.clear()
            assert bt_session._keepalive_managed_browser(state["key"], 7)["success"] is False
            assert calls == [["session", "list"]], (version, response, calls)
        # An unrecorded launch identity must never be guessed from global config.
        bt._active_sessions[state["key"]].pop("managed_engine", None)
        calls.clear()
        with monkeypatch.context() as missing_engine:
            missing_engine.setattr(bt_cloud, "_get_browser_engine", lambda: "auto")
            assert bt_session._keepalive_managed_browser(state["key"], 7)["success"] is False
            assert calls == []


def test_registry_unnamed_managed_calls_use_different_task_daemons(tmp_path, monkeypatch):
    _managed_route(monkeypatch)
    cli = _fake_cli(tmp_path, 'cat > /dev/null\necho "${BU_NAME:-default}"\n')
    monkeypatch.setattr(bu_cli, "_find_cli", lambda: [cli])

    def daemon(task_id):
        result = json.loads(registry.dispatch("browser_exec", {"code": "print(1)"}, task_id=task_id))
        assert result["success"] is True
        return result["output"].strip()

    first, second, first_again = daemon("task-a"), daemon("task-b"), daemon("task-a")
    assert first != second
    assert first == first_again
