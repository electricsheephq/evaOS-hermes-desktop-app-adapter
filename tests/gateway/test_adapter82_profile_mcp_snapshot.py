"""Regression coverage for adapter#82 profile-overlay MCP discovery."""

import pytest


def test_profile_overlay_discovery_precedes_gateway_agent_snapshot(
    tmp_path, monkeypatch
):
    import gateway.run as gateway_run
    from agent import secret_scope
    from hermes_constants import (
        get_hermes_home,
        reset_hermes_home_override,
        set_hermes_home_override,
    )
    from tools import mcp_tool

    profile = tmp_path / "profiles" / "profile-a"
    profile.mkdir(parents=True)
    (profile / "config.yaml").write_text(
        "mcp_servers:\n  synthetic:\n    url: https://example.invalid/mcp\n",
        encoding="utf-8",
    )
    discovered = {"synthetic": {}}

    def discover():
        assert get_hermes_home().resolve() == profile.resolve()
        discovered.update(mcp_tool._load_mcp_config())
        return ["mcp__synthetic__search"]

    monkeypatch.setattr(mcp_tool, "discover_mcp_tools", discover)
    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", True)
    token = set_hermes_home_override(str(profile))
    try:
        snapshot = gateway_run._create_gateway_agent(
            lambda **_kwargs: dict(discovered["synthetic"])
        )
        factory_calls = []

        def fail_discovery():
            raise RuntimeError("discovery failed")

        monkeypatch.setattr(mcp_tool, "discover_mcp_tools", fail_discovery)
        with pytest.raises(RuntimeError, match="discovery failed"):
            gateway_run._create_gateway_agent(
                lambda **_kwargs: factory_calls.append(True)
            )
    finally:
        reset_hermes_home_override(token)

    assert snapshot["url"] == "https://example.invalid/mcp"
    assert factory_calls == []


def test_single_profile_factory_does_not_discover(monkeypatch):
    import gateway.run as gateway_run
    from agent import secret_scope
    from tools import mcp_tool

    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", False)
    monkeypatch.setattr(
        mcp_tool,
        "discover_mcp_tools",
        lambda: pytest.fail("single-profile factory must stay inert"),
    )

    assert gateway_run._create_gateway_agent(lambda value: value, value=7) == 7
