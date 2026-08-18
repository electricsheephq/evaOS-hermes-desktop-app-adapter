"""Regression coverage for profile-scoped MCP registry state."""

from tools.registry import ToolRegistry


def _schema(name: str) -> dict:
    return {
        "name": name,
        "description": name,
        "parameters": {"type": "object", "properties": {}},
    }


def _handler(_args):
    return "ok"


def test_scoped_deregister_preserves_alias_until_last_toolset_owner():
    registry = ToolRegistry()
    registry.register_toolset_alias("same", "mcp-same")
    registry.register(
        "mcp__same__one",
        "mcp-same",
        _schema("mcp__same__one"),
        _handler,
        scope="profile-a",
    )
    registry.register(
        "mcp__same__two",
        "mcp-same",
        _schema("mcp__same__two"),
        _handler,
        scope="profile-b",
    )

    registry.deregister("mcp__same__one", scope="profile-a")

    assert registry.get_toolset_alias_target("same") == "mcp-same"

    registry.deregister("mcp__same__two", scope="profile-b")

    assert registry.get_toolset_alias_target("same") is None
