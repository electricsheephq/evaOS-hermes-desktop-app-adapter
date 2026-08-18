"""Profile-overlay MCP discovery and state isolation regressions."""

from types import SimpleNamespace

import pytest


def test_profile_overlay_discovery_precedes_agent_snapshot(tmp_path, monkeypatch):
    import gateway.run as gateway_run
    from agent import secret_scope
    from hermes_constants import get_hermes_home
    from tests.hermes_cli.test_managed_mcp_profile_scope import (
        _profile_scope,
        _setup_scopes,
    )
    from tools import mcp_tool

    _, profile, _ = _setup_scopes(tmp_path, monkeypatch)
    discovered = {"gbrain": {}}
    factory_calls = []

    def discover():
        assert get_hermes_home().resolve() == profile.resolve()
        discovered.update(mcp_tool._load_mcp_config())
        return ["mcp__gbrain__search"]

    def build_snapshot():
        factory_calls.append(True)
        return dict(discovered["gbrain"])

    monkeypatch.setattr(mcp_tool, "discover_mcp_tools", discover)
    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", True)
    with _profile_scope(profile):
        gateway_run._prepare_mcp_registry_for_gateway_agent()
        snapshot = build_snapshot()
        with pytest.raises(RuntimeError, match="discovery failed"):
            raise RuntimeError("discovery failed")

    assert snapshot["url"] == "https://jane.gbrain.example/mcp"
    assert factory_calls == [True]


def test_scoped_shutdown_preserves_sibling_profile_state(tmp_path, monkeypatch):
    from agent import secret_scope
    from tests.hermes_cli.test_managed_mcp_profile_scope import _profile_scope
    from tools import mcp_tool

    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", True)
    eve = tmp_path / "profiles" / "eve"
    grace = tmp_path / "profiles" / "grace"
    eve.mkdir(parents=True)
    grace.mkdir(parents=True)

    try:
        with _profile_scope(eve):
            mcp_tool._server_connect_retry_after["gmail"] = 10.0
            mcp_tool._tool_read_only_hints["gmail"] = {"read": True}
        with _profile_scope(grace):
            mcp_tool._server_connect_retry_after["gmail"] = 20.0
            mcp_tool._tool_read_only_hints["gmail"] = {"read": False}

        with _profile_scope(eve):
            mcp_tool.shutdown_mcp_servers_for_current_scope()
            assert "gmail" not in mcp_tool._server_connect_retry_after
            assert "gmail" not in mcp_tool._tool_read_only_hints

        with _profile_scope(grace):
            assert mcp_tool._server_connect_retry_after["gmail"] == 20.0
            assert mcp_tool._tool_read_only_hints["gmail"] == {"read": False}
    finally:
        for home in (eve, grace):
            with _profile_scope(home):
                mcp_tool._server_connect_retry_after.clear()
                mcp_tool._tool_read_only_hints.clear()


def test_equal_server_names_keep_profile_local_connection_state(
    tmp_path, monkeypatch
):
    from agent import secret_scope
    from tests.hermes_cli.test_managed_mcp_profile_scope import _profile_scope
    from tools import mcp_tool

    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", True)
    homes = [tmp_path / "profiles" / "jane", tmp_path / "profiles" / "louis"]
    servers = []
    for index, home in enumerate(homes):
        home.mkdir(parents=True)
        server = SimpleNamespace(session=object(), identity=f"profile-{index}")
        servers.append(server)
        with _profile_scope(home):
            mcp_tool._servers["pipedream"] = server
            mcp_tool._tool_read_only_hints["pipedream"] = {"read": index == 0}

    for index, home in enumerate(homes):
        with _profile_scope(home):
            assert mcp_tool._servers["pipedream"] is servers[index]
            assert mcp_tool._tool_read_only_hints["pipedream"] == {
                "read": index == 0
            }
            mcp_tool._servers.pop("pipedream")
            mcp_tool._tool_read_only_hints.pop("pipedream")
