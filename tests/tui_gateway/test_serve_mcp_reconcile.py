"""Serve-only config pickup and Desktop typed reload regression for adapter #452."""

import threading
import time
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

import hermes_cli.mcp_startup as startup
from hermes_cli.config import atomic_config_write, load_config
from hermes_constants import hermes_home_key
from agent.secret_scope import current_secret_scope
from tools import mcp_tool_agent as agent_tools
from tools import mcp_tool_discovery as discovery
from tools import mcp_tool_lifecycle as lifecycle
from tools import mcp_oauth
import tui_gateway.server as srv


@pytest.fixture
def env(monkeypatch, tmp_path):
    homes = [tmp_path / str(i) for i in range(3)]
    for home in homes:
        home.mkdir()
        atomic_config_write(home / "config.yaml", {"mcp_servers": {"one": {"command": "fake"}}})
    monkeypatch.setattr(srv, "_hermes_home", homes[0])
    monkeypatch.setenv("HERMES_HOME", str(homes[0]))
    monkeypatch.setattr(srv, "get_process_hermes_home", lambda: homes[0])
    from tui_gateway.launch_profile_policy import activate_multi_profile_hosting
    activate_multi_profile_hosting()
    monkeypatch.setattr(startup, "_mcp_discovery_started", {hermes_home_key(homes[2])})
    sessions = {
        str(i): {"profile_home": str(home), "agent": SimpleNamespace(name=str(i)),
                 "session_key": str(i), "running": False}
        for i, home in enumerate(homes[:2])
    }
    sessions["remote"] = {**sessions["1"], "agent": SimpleNamespace(name="remote"), "remote": True}
    worker = Mock()
    worker.run.return_value = "worker-only reload"
    sessions["1"]["slash_worker"] = worker
    monkeypatch.setattr(srv, "_sessions", sessions)
    monkeypatch.setattr(srv, "_session_uses_compute_host", lambda sess: sess.get("remote", False))
    monkeypatch.setattr(srv, "_load_enabled_toolsets", lambda *_a: [])
    monkeypatch.setattr(srv, "_emit", lambda *_a: None)
    monkeypatch.setattr(srv, "_session_info", lambda *_a: {})
    monkeypatch.setattr(srv, "_mcp_reload_lock", threading.Lock())
    monkeypatch.setattr(srv, "_mcp_reload_gen", 0)
    refreshed = []
    monkeypatch.setattr(agent_tools, "refresh_agent_mcp_tools",
                        lambda agent, **kw: refreshed.append((agent.name, kw)))
    connected = {hermes_home_key(home): {"one"} for home in homes}
    calls = []
    removed = []
    fail = [False]

    def status():
        known = connected[hermes_home_key()]
        return [{"status": "connected" if name in known else "configured", "disabled": False}
                for name in load_config().get("mcp_servers", {})]

    def reconcile():
        home = hermes_home_key()
        assert current_secret_scope() is not None
        assert not mcp_oauth._oauth_interactive_enabled.get()
        wanted = set(load_config().get("mcp_servers", {}))
        calls.append(home)
        added = sorted(wanted - connected[home])
        gone = sorted(connected[home] - wanted)
        removed.extend(gone)
        if not fail[0]:
            connected[home] = wanted
        return {"added": added, "removed": gone, "pending": []}

    monkeypatch.setattr(discovery, "get_mcp_status", status)
    monkeypatch.setattr(discovery, "reconcile_mcp_servers_with_config", reconcile)
    reloads = []
    monkeypatch.setattr(lifecycle, "shutdown_mcp_servers", lambda: reloads.append("shutdown"))
    monkeypatch.setattr(agent_tools, "reprobe_tool_availability", lambda: None)
    monkeypatch.setattr(discovery, "discover_mcp_tools", lambda: reloads.append(hermes_home_key()))
    return SimpleNamespace(homes=homes, calls=calls, connected=connected, refreshed=refreshed,
                           worker=worker, reloads=reloads, fail=fail)


def reconciler():
    from tui_gateway.mcp_reconcile import ServeMCPReconciler
    return ServeMCPReconciler(srv)


def edit(home, names):
    atomic_config_write(home / "config.yaml", {"mcp_servers": {name: {"command": "fake"} for name in names}})


def test_add_scoped_server_refreshes_only_local_home_and_skips_unchanged(env):
    tick = reconciler()
    tick.pass_once()
    edit(env.homes[1], ["one", "two"])
    tick.pass_once()
    assert env.calls == [hermes_home_key(env.homes[1])]
    assert [name for name, _ in env.refreshed] == ["1"]
    assert env.refreshed[0][1]["preserve_prefix"] is True
    tick.pass_once()
    assert len(env.calls) == 1


def test_first_pass_skipped_for_each_home_including_discovery_only_home(env):
    tick = reconciler()
    tick.pass_once()
    assert env.calls == []
    edit(env.homes[2], ["one", "two"])
    tick.pass_once()
    assert env.calls == [hermes_home_key(env.homes[2])]
    assert env.refreshed == []


def test_reload_lock_skips_without_waiting(env):
    tick = reconciler()
    tick.pass_once()
    edit(env.homes[0], ["one", "two"])
    with srv._mcp_reload_lock:
        before = time.monotonic()
        tick.pass_once()
        assert time.monotonic() - before < 2
    assert env.calls == []
    tick.pass_once()
    assert env.calls == [hermes_home_key(env.homes[0])]


def test_removal_does_not_refresh_open_chats(env):
    tick = reconciler()
    tick.pass_once()
    edit(env.homes[0], [])
    tick.pass_once()
    assert env.calls == [hermes_home_key(env.homes[0])]
    assert env.refreshed == []


def test_missing_server_retried_without_config_change(env):
    tick = reconciler()
    tick.pass_once()
    env.fail[0] = True
    edit(env.homes[0], ["one", "two"])
    tick.pass_once()
    env.fail[0] = False
    tick.pass_once()
    tick.pass_once()
    assert env.calls == [hermes_home_key(env.homes[0])] * 2


def test_background_pass_does_not_block_start_or_spawn_more_workers(env, monkeypatch):
    from tui_gateway import mcp_reconcile

    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    calls = []

    def slow_pass(self):
        calls.append(threading.current_thread().name)
        entered.set()
        assert release.wait(5)
        finished.set()

    monkeypatch.setattr(mcp_reconcile.ServeMCPReconciler, "pass_once", slow_pass)
    stop = mcp_reconcile.start_serve_mcp_reconcile()
    try:
        assert entered.wait(2)
        assert not finished.is_set()
        assert calls == ["serve-mcp-reconcile"]
    finally:
        stop.set()
        release.set()
        assert finished.wait(2)


def test_typed_reload_requires_confirmation_and_bypasses_worker(env):
    response = srv._methods["slash.exec"](1, {"session_id": "1", "command": "/reload-mcp"})
    assert "/reload-mcp now" in response["result"]["output"]
    assert env.reloads == []
    env.worker.run.assert_not_called()


def test_typed_reload_now_runs_real_body_once(env):
    response = srv._methods["slash.exec"](1, {"session_id": "1", "command": "/reload-mcp now"})
    assert "reloaded" in response["result"]["output"].lower()
    assert env.reloads.count("shutdown") == 1
    assert hermes_home_key(env.homes[0]) in env.reloads
    assert hermes_home_key(env.homes[1]) in env.reloads
    assert {name for name, _ in env.refreshed} >= {"0", "1"}
    env.worker.run.assert_not_called()
    assert "reload-mcp" not in srv._SLASH_MIRRORS


def test_typed_reload_always_persists_calling_home_only(env):
    response = srv._methods["slash.exec"](1, {"session_id": "1", "command": "/reload-mcp always"})
    assert "reloaded" in response["result"]["output"].lower()
    with srv._session_profile_runtime_scope({"profile_home": str(env.homes[1])}):
        assert load_config()["approvals"]["mcp_reload_confirm"] is False
    with srv._session_profile_runtime_scope({"profile_home": str(env.homes[0])}):
        assert load_config()["approvals"]["mcp_reload_confirm"] is True
    assert env.reloads.count("shutdown") == 1
    env.worker.run.assert_not_called()
