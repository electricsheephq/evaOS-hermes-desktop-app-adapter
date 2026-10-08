"""Real-path serve pickup and typed reload invariants for adapter #452."""

import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
import yaml

import hermes_cli.mcp_startup as startup
from hermes_cli.config import atomic_config_write
from hermes_constants import hermes_home_key
from tools import mcp_tool
from tools import mcp_tool_agent as agent_tools
from tools import mcp_tool_discovery as discovery
from tools import mcp_tool_lifecycle as lifecycle
from tools import mcp_tool_loop as mcp_loop
import tui_gateway.server as srv


@pytest.fixture
def env(monkeypatch, tmp_path):
    homes = [tmp_path / name for name in ("launch", "secondary")]
    for home in homes:
        home.mkdir()
        atomic_config_write(home / "config.yaml", {
            "mcp_servers": {}, "approvals": {"mcp_reload_confirm": True},
        })
    monkeypatch.setenv("HERMES_HOME", str(homes[0]))
    monkeypatch.setenv("HERMES_TUI_TOOLSETS", "mcp")
    monkeypatch.setattr(srv, "_hermes_home", homes[0])
    monkeypatch.setattr(srv, "get_process_hermes_home", lambda: homes[0])
    from tui_gateway.launch_profile_policy import activate_multi_profile_hosting
    activate_multi_profile_hosting()
    monkeypatch.setattr(startup, "_mcp_discovery_started", set())
    sessions = {
        str(i): {
            "profile_home": str(home) if i else None,
            "agent": SimpleNamespace(name=str(i), tools=[], valid_tool_names=set()),
            "session_key": str(i), "running": False,
            "history": [], "history_lock": threading.RLock(),
        }
        for i, home in enumerate(homes)
    }
    worker = Mock()
    worker.run.return_value = "worker-only reload"
    sessions["1"]["slash_worker"] = worker
    monkeypatch.setattr(srv, "_sessions", sessions)
    monkeypatch.setattr(srv, "_emit", lambda *_a: None)
    monkeypatch.setattr(srv, "_session_info", lambda *_a: {})
    monkeypatch.setattr(srv, "_mcp_reload_lock", threading.Lock())
    monkeypatch.setattr(srv, "_mcp_reload_gen", 0)
    monkeypatch.setattr(srv, "_mcp_reload_loaded_rev", "")
    connected = []

    async def start(server, config):
        # Only transport bring-up is synthetic; discovery adopts the real task.
        connected.append((hermes_home_key(), server.name))
        server._config = config
        server.session = SimpleNamespace()

    monkeypatch.setattr(mcp_tool.MCPServerTask, "start", start)
    reconcile = Mock(wraps=discovery.reconcile_mcp_servers_with_config)
    refresh = Mock(wraps=agent_tools.refresh_agent_mcp_tools)
    shutdown = Mock(wraps=lifecycle.shutdown_mcp_servers)
    monkeypatch.setattr(discovery, "reconcile_mcp_servers_with_config", reconcile)
    monkeypatch.setattr(agent_tools, "refresh_agent_mcp_tools", refresh)
    monkeypatch.setattr(lifecycle, "shutdown_mcp_servers", shutdown)
    yield SimpleNamespace(homes=homes, sessions=sessions, connected=connected,
                          reconcile=reconcile, refresh=refresh, shutdown=shutdown, worker=worker)
    lifecycle.shutdown_mcp_servers()
    mcp_loop._stop_mcp_loop()


def test_serve_picks_up_config_once_and_refreshes_only_its_home(env):
    from tui_gateway.mcp_reconcile import ServeMCPReconciler

    tick = ServeMCPReconciler(srv)
    tick.pass_once()
    assert set(tick.revisions) == {hermes_home_key(home) for home in env.homes}
    assert all(tick.revisions.values())
    env.reconcile.assert_not_called()
    assert env.connected == []
    env.refresh.assert_not_called()

    home = env.homes[1]
    config = yaml.safe_load((home / "config.yaml").read_text())
    config["mcp_servers"]["demo"] = {"command": "synthetic", "lazy": False}
    atomic_config_write(home / "config.yaml", config)
    revisions = dict(tick.revisions)
    with srv._mcp_reload_lock:
        tick.pass_once()
    assert tick.revisions == revisions
    env.reconcile.assert_not_called()

    tick.pass_once()
    assert env.connected == [(hermes_home_key(home), "demo")]
    env.reconcile.assert_called_once_with()
    env.refresh.assert_called_once()
    assert env.refresh.call_args.args == (env.sessions["1"]["agent"],)
    assert env.refresh.call_args.kwargs["preserve_prefix"] is True
    with srv._session_profile_runtime_scope(env.sessions["1"]):
        assert discovery.get_mcp_status()[0]["status"] == "connected"
    tick.pass_once()
    env.reconcile.assert_called_once_with()
    env.refresh.assert_called_once()
    assert env.connected == [(hermes_home_key(home), "demo")]


@pytest.mark.parametrize("arg", ["", "now", "always"])
def test_typed_reload_honors_confirmation_without_using_slash_worker(env, arg):
    response = srv._methods["slash.exec"](1, {
        "session_id": "1", "command": f"/reload-mcp {arg}".strip(),
    })
    assert "error" not in response
    output = response["result"]["output"]
    if not arg:
        assert "/reload-mcp now" in output
        env.shutdown.assert_not_called()
        env.refresh.assert_not_called()
    else:
        assert "reloaded" in output.lower()
        env.shutdown.assert_called_once_with()
        assert {call.args[0].name for call in env.refresh.call_args_list} == {"0", "1"}
    assert srv._mcp_reload_gen == int(bool(arg))
    for i, home in enumerate(env.homes):
        saved = yaml.safe_load((home / "config.yaml").read_text())
        assert saved["approvals"]["mcp_reload_confirm"] is not (arg == "always" and i == 1)
    env.worker.run.assert_not_called()
