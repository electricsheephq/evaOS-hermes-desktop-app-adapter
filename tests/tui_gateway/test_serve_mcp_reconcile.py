"""Real-path serve pickup and typed reload invariants for adapter #452."""

import threading
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

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
    monkeypatch.setenv("HERMES_TUI_TOOLSETS", "seed,demo")
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
        server._tools = [SimpleNamespace(
            name="ping", description="Synthetic ping", inputSchema={"type": "object", "properties": {}},
            annotations={"readOnlyHint": True},
        )]
        from mcp.types import CallToolResult, TextContent
        server.session = SimpleNamespace(call_tool=AsyncMock(return_value=CallToolResult(
            content=[TextContent(type="text", text="pong")],
        )))

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


@pytest.mark.parametrize("search_enabled,contended", [(True, False), (False, False), (True, True)],
                         ids=["search-on", "search-off", "discovery-contended"])
def test_serve_picks_up_config_once_and_refreshes_only_its_home(env, monkeypatch, search_enabled, contended):
    from model_tools import get_tool_definitions, handle_function_call
    from tools.registry import registry
    from tui_gateway.mcp_reconcile import ServeMCPReconciler

    # Real model-facing snapshots for two homes with opposite tool-search policies.
    for i, home in enumerate(env.homes):
        config = yaml.safe_load((home / "config.yaml").read_text())
        config["tools"] = {"tool_search": {"enabled": search_enabled if i else not search_enabled}}
        config["mcp_servers"]["seed"] = {"command": f"synthetic-{i}", "lazy": False}
        atomic_config_write(home / "config.yaml", config)
        with srv._session_profile_runtime_scope(env.sessions[str(i)]):
            discovery.discover_mcp_tools()
            agent = env.sessions[str(i)]["agent"]
            agent.enabled_toolsets = ["seed"]
            agent.tools = get_tool_definitions(enabled_toolsets=["seed"], quiet_mode=True)
            agent.valid_tool_names = set(agent_tools.agent_tool_names(agent))
    env.connected.clear()
    snapshots = {sid: list(sess["agent"].tools) for sid, sess in env.sessions.items()}
    assert ("tool_search" in env.sessions["1"]["agent"].valid_tool_names) is search_enabled

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

    if contended:
        with srv._session_profile_runtime_scope(env.sessions["1"]):
            cookie = mcp_loop._try_acquire_mcp_discovery_lock()
        assert cookie is not None and cookie is not mcp_tool._LOCK_UNAVAILABLE
        try:
            # A separately held real file-lock descriptor simulates another process.
            # Fail immediately if the background pass enters the minutes-long retry loop.
            with monkeypatch.context() as patch:
                wait = Mock(side_effect=AssertionError("background discovery must not wait"))
                patch.setattr(discovery.time, "sleep", wait)
                started = time.monotonic()
                tick.pass_once()
                assert time.monotonic() - started < 2.0
                wait.assert_not_called()
            assert hermes_home_key(home) in tick.pending
            assert env.connected == []
            env.refresh.assert_not_called()
            assert srv._mcp_reload_lock.acquire(blocking=False)
            srv._mcp_reload_lock.release()
        finally:
            cookie.release()
        env.reconcile.reset_mock()

    tick.pass_once()
    assert env.connected == [(hermes_home_key(home), "demo")]
    env.reconcile.assert_called_once()
    assert hermes_home_key(home) not in tick.pending
    if search_enabled:
        env.refresh.assert_called_once()
        assert env.refresh.call_args.args == (env.sessions["1"]["agent"],)
        assert env.refresh.call_args.kwargs["preserve_prefix"] is True
    else:
        env.refresh.assert_not_called()
    assert {sid: sess["agent"].tools for sid, sess in env.sessions.items()} == snapshots
    with srv._session_profile_runtime_scope(env.sessions["1"]):
        assert all(row["status"] == "connected" for row in discovery.get_mcp_status())
        assert registry.get_entry("mcp__demo__ping") is not None
        assert "pong" in handle_function_call("mcp__demo__ping", {})
        # A newly built session still sees the server with tool search off.
        new_tools = get_tool_definitions(enabled_toolsets=["seed", "demo"], quiet_mode=True)
        assert ("mcp__demo__ping" in {td["function"]["name"] for td in new_tools}) is not search_enabled
    tick.pass_once()
    env.reconcile.assert_called_once()
    assert env.refresh.call_count == int(search_enabled)
    assert env.connected == [(hermes_home_key(home), "demo")]
    if not search_enabled:
        response = srv._methods["slash.exec"](1, {"session_id": "1", "command": "/reload-mcp now"})
        assert "reloaded" in response["result"]["output"].lower()
        assert "mcp__demo__ping" in env.sessions["1"]["agent"].valid_tool_names


@pytest.mark.parametrize("command,arg", [("reload-mcp", ""), ("reload-mcp", "now"),
                                         ("reload-mcp", "always"), ("reload_mcp", "now")])
def test_typed_reload_honors_confirmation_without_using_slash_worker(env, command, arg):
    response = srv._methods["slash.exec"](1, {
        "session_id": "1", "command": f"/{command} {arg}".strip(),
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
