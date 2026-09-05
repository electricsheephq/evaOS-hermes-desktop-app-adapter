"""Regression coverage for adapter#82 profile-overlay MCP discovery."""

import asyncio
from types import SimpleNamespace


def test_profile_overlay_discovery_precedes_gateway_agent_snapshot(
    tmp_path, monkeypatch
):
    from hermes_constants import get_hermes_home
    import gateway.run as gateway_run
    from tests.hermes_cli.test_managed_mcp_profile_scope import (
        _profile_scope,
        _setup_scopes,
    )
    from tools import mcp_tool_config, mcp_tool_discovery

    _, profile, _ = _setup_scopes(tmp_path, monkeypatch)
    discovered = {"gbrain": {}}

    def discover():
        assert get_hermes_home().resolve() == profile.resolve()
        discovered.update(mcp_tool_config._load_mcp_config())
        return ["mcp__gbrain__search"]

    monkeypatch.setattr(mcp_tool_discovery, "discover_mcp_tools", discover)
    monkeypatch.setattr(
        gateway_run,
        "_multiplex_profile_homes",
        lambda _config: [("jane", profile)],
    )
    with _profile_scope(profile):
        # The split gateway completes profile discovery before the downstream
        # agent builder snapshots its tools.
        asyncio.run(
            gateway_run._discover_gateway_mcp_tools(
                SimpleNamespace(multiplex_profiles=True)
            )
        )
        snapshot = dict(discovered["gbrain"])

    assert snapshot["url"] == "https://jane.gbrain.example/mcp"


def test_profile_discovery_signals_stale_task_through_defining_module(
    tmp_path, monkeypatch
):
    from tools import mcp_tool, mcp_tool_discovery

    monkeypatch.setattr(mcp_tool, "_servers", {})
    monkeypatch.setattr(mcp_tool, "_server_scope_keys", {})
    monkeypatch.setattr(mcp_tool, "_server_connecting", set())
    shutdowns = []

    def stale_task(key, label):
        async def shutdown():
            shutdowns.append(label)

        return SimpleNamespace(
            name="gbrain",
            state_key=key,
            session=None,
            _config={},
            _error=ValueError("gbrain has no 'command' in config"),
            shutdown=shutdown,
        )

    current_key = "gbrain"
    mcp_tool._servers[current_key] = stale_task(current_key, "current")
    signaled = []
    monkeypatch.setattr(
        mcp_tool_discovery._loop,
        "_signal_reconnect",
        lambda server: signaled.append(server.name),
    )

    selected = mcp_tool_discovery._select_new_servers(
        {"gbrain": {"command": "gbrain-server"}}
    )

    assert selected == {}
    assert signaled == ["gbrain"]
    assert mcp_tool._servers[current_key].session is None
    assert shutdowns == []
