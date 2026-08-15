"""Profile-overlay MCP discovery and state isolation regressions."""

from types import SimpleNamespace

import pytest


def test_profile_overlay_discovery_precedes_agent_snapshot(tmp_path, monkeypatch):
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

    def build_snapshot():
        factory_calls.append(True)
        return dict(discovered["gbrain"])

    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", True)
    with _profile_scope(profile):
        discover()
        snapshot = build_snapshot()
        with pytest.raises(RuntimeError, match="discovery failed"):
            raise RuntimeError("discovery failed")

    assert snapshot["url"] == "https://jane.gbrain.example/mcp"
    assert factory_calls == [True]


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
