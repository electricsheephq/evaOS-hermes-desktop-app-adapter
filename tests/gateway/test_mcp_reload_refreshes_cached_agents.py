"""Regression test for /reload-mcp refreshing cached agent tool lists.

Before this fix, the gateway's _execute_mcp_reload reconnected MCP servers
and updated the global _servers registry, but cached AIAgent instances kept
their original tools list. Users had to run /new (discarding conversation
history) for the agent to pick up the new tools.

This test exercises _execute_mcp_reload directly with mocked MCP discovery
and asserts that every cached agent's `tools` and `valid_tool_names`
attributes are overwritten with the freshly-discovered tool set.
"""

from __future__ import annotations

from collections import OrderedDict
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from gateway.config import GatewayConfig, Platform, PlatformConfig
from gateway.platforms.base import MessageEvent
from gateway.session import SessionEntry, SessionSource, build_session_key


def _make_source() -> SessionSource:
    return SessionSource(
        platform=Platform.TELEGRAM,
        user_id="u1",
        chat_id="c1",
        user_name="tester",
        chat_type="dm",
    )


def _make_event() -> MessageEvent:
    return MessageEvent(text="/reload-mcp", source=_make_source(), message_id="m1")


def _make_runner_with_cached_agents(num_agents: int = 2):
    """Build a bare GatewayRunner with `num_agents` fake cached agents."""
    import threading

    from gateway.run import GatewayRunner

    runner = object.__new__(GatewayRunner)
    runner.config = GatewayConfig(
        platforms={Platform.TELEGRAM: PlatformConfig(enabled=True, token="***")}
    )

    # Session store stub — _execute_mcp_reload writes a transcript message
    # at the end; tests don't care about that side effect.
    session_entry = SessionEntry(
        session_key=build_session_key(_make_source()),
        session_id="sess-1",
        created_at=datetime.now(),
        updated_at=datetime.now(),
        platform=Platform.TELEGRAM,
        chat_type="dm",
    )
    runner.session_store = MagicMock()
    runner.session_store.get_or_create_session.return_value = session_entry
    runner.session_store.append_to_transcript = MagicMock()

    # Build N fake cached agents with stale `tools` + `valid_tool_names`.
    runner._agent_cache = OrderedDict()
    runner._agent_cache_lock = threading.Lock()
    for i in range(num_agents):
        stale_tool = {
            "type": "function",
            "function": {"name": f"stale_tool_{i}", "description": "old"},
        }
        agent = SimpleNamespace(
            tools=[stale_tool],
            valid_tool_names={f"stale_tool_{i}"},
            enabled_toolsets=None,
            disabled_toolsets=None,
        )
        runner._agent_cache[f"session-{i}"] = (agent, f"sig-{i}")

    return runner


@pytest.mark.asyncio
async def test_reload_mcp_refreshes_cached_agent_tools():
    """After /reload-mcp succeeds, every cached agent gets its tool list
    replaced with the freshly-discovered set."""
    runner = _make_runner_with_cached_agents(num_agents=3)

    # Snapshot the stale state so we can assert it changed.
    pre_reload_tools = {
        key: list(entry[0].tools) for key, entry in runner._agent_cache.items()
    }

    # Fresh tools that get_tool_definitions() will return after the reload.
    fresh_tool_defs = [
        {
            "type": "function",
            "function": {"name": "HassTurnOn", "description": "Turns on a device"},
        },
        {
            "type": "function",
            "function": {"name": "HassTurnOff", "description": "Turns off a device"},
        },
    ]

    with (
        patch("tools.mcp_tool.shutdown_mcp_servers"),
        patch("tools.mcp_tool.discover_mcp_tools", return_value=["HassTurnOn", "HassTurnOff"]),
        patch.dict("tools.mcp_tool._servers", {"homeassistant": object()}, clear=True),
        patch("model_tools.get_tool_definitions", return_value=fresh_tool_defs),
    ):
        result = await runner._execute_mcp_reload(_make_event())

    # The reload itself returned a status string (not an exception).
    assert isinstance(result, str)

    # Every cached agent has fresh tools and the matching valid_tool_names.
    expected_names = {"HassTurnOn", "HassTurnOff"}
    for key, (agent, _sig) in runner._agent_cache.items():
        assert agent.tools == fresh_tool_defs, (
            f"Agent {key} kept stale tools: {agent.tools} != {fresh_tool_defs}"
        )
        assert agent.valid_tool_names == expected_names, (
            f"Agent {key} kept stale valid_tool_names: {agent.valid_tool_names}"
        )
        # Sanity check that the swap actually changed something.
        assert agent.tools != pre_reload_tools[key]


@pytest.mark.asyncio
async def test_reload_mcp_handles_empty_agent_cache():
    """Reload with no cached agents (e.g. fresh gateway) must not raise."""
    runner = _make_runner_with_cached_agents(num_agents=0)
    assert len(runner._agent_cache) == 0

    with (
        patch("tools.mcp_tool.shutdown_mcp_servers"),
        patch("tools.mcp_tool.discover_mcp_tools", return_value=[]),
        patch.dict("tools.mcp_tool._servers", {}, clear=True),
        patch("model_tools.get_tool_definitions", return_value=[]),
    ):
        result = await runner._execute_mcp_reload(_make_event())

    assert isinstance(result, str)


@pytest.mark.asyncio
async def test_reload_mcp_preserves_per_agent_toolset_overrides():
    """If a cached agent was built with enabled_toolsets=["safe"], the
    refresh must pass that same list to get_tool_definitions so the agent
    doesn't silently gain disabled tools after a reload."""
    runner = _make_runner_with_cached_agents(num_agents=1)
    # Override the toolsets on the cached agent.
    agent, _sig = runner._agent_cache["session-0"]
    agent.enabled_toolsets = ["safe"]
    agent.disabled_toolsets = ["terminal"]

    captured_calls = []

    def _capture_get_tool_definitions(**kwargs):
        captured_calls.append(kwargs)
        return [{"type": "function", "function": {"name": "refreshed"}}]

    with (
        patch("tools.mcp_tool.shutdown_mcp_servers"),
        patch("tools.mcp_tool.discover_mcp_tools", return_value=["refreshed"]),
        patch.dict("tools.mcp_tool._servers", {"homeassistant": object()}, clear=True),
        patch("model_tools.get_tool_definitions", side_effect=_capture_get_tool_definitions),
    ):
        await runner._execute_mcp_reload(_make_event())

    assert captured_calls, "get_tool_definitions was never called to refresh the cache"
    assert captured_calls[0]["enabled_toolsets"] == ["safe"]
    assert captured_calls[0]["disabled_toolsets"] == ["terminal"]


@pytest.mark.asyncio
async def test_multiplex_reload_refreshes_only_routed_profile_cache(
    tmp_path, monkeypatch
):
    from agent import secret_scope
    from hermes_constants import get_hermes_home
    runner = _make_runner_with_cached_agents(num_agents=2)
    runner.config.multiplex_profiles = True
    eve_entry, grace_entry = list(runner._agent_cache.values())
    runner._agent_cache = OrderedDict(
        [
            ("agent:eve:discord:channel:eve", eve_entry),
            ("agent:grace:discord:channel:grace", grace_entry),
        ]
    )
    event = _make_event()
    event.source.profile = "eve"
    refreshed = []
    seen_shutdown_homes = []
    eve_home = tmp_path / "profiles" / "eve"
    eve_home.mkdir(parents=True)
    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", True)

    def _scoped_shutdown():
        seen_shutdown_homes.append(get_hermes_home().resolve())

    runner._resolve_profile_home_for_source = lambda _source: eve_home

    try:
        with (
            patch("tools.mcp_tool.shutdown_mcp_servers") as global_shutdown,
            patch(
                "tools.mcp_tool.shutdown_mcp_servers_for_current_scope",
                side_effect=_scoped_shutdown,
            ) as scoped_shutdown,
            patch(
                "tools.mcp_tool.discover_mcp_tools",
                return_value=["gmail_read"],
            ),
            patch.dict(
                "tools.mcp_tool._servers",
                {(str(eve_home.resolve()), "gmail"): object()},
                clear=True,
            ),
            patch(
                "tools.mcp_tool.refresh_agent_mcp_tools",
                side_effect=lambda agent, **_kwargs: refreshed.append(agent),
            ),
        ):
            result = await runner._execute_mcp_reload(event)
    finally:
        executor = getattr(runner, "_executor", None)
        if executor is not None:
            executor.shutdown(wait=True)

    assert isinstance(result, str)
    scoped_shutdown.assert_called_once_with()
    global_shutdown.assert_not_called()
    assert seen_shutdown_homes == [eve_home.resolve()]
    assert refreshed == [eve_entry[0]]
    assert grace_entry[0] not in refreshed


def test_scoped_mcp_shutdown_preserves_sibling_profile_state(tmp_path, monkeypatch):
    from agent import secret_scope
    from tests.hermes_cli.test_managed_mcp_profile_scope import _profile_scope
    from tools import mcp_tool

    eve_home = (tmp_path / "profiles" / "eve").resolve()
    grace_home = (tmp_path / "profiles" / "grace").resolve()
    eve_home.mkdir(parents=True)
    grace_home.mkdir(parents=True)
    eve_key = (str(eve_home), "gmail")
    grace_key = (str(grace_home), "drive")
    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", True)

    with (
        patch.dict(mcp_tool._servers, {eve_key: object(), grace_key: object()}, clear=True),
        patch.dict(
            mcp_tool._server_connect_errors,
            {eve_key: "eve-error", grace_key: "grace-error"},
            clear=True,
        ),
        patch.object(mcp_tool, "_server_connecting", {eve_key, grace_key}),
        patch.object(mcp_tool, "_parallel_safe_servers", {eve_key, grace_key}),
        patch.object(mcp_tool, "_mcp_loop", None),
    ):
        with _profile_scope(eve_home):
            mcp_tool.shutdown_mcp_servers_for_current_scope()

        assert eve_key not in mcp_tool._servers
        assert eve_key not in mcp_tool._server_connect_errors
        assert eve_key not in mcp_tool._server_connecting
        assert eve_key not in mcp_tool._parallel_safe_servers
        assert grace_key in mcp_tool._servers
        assert grace_key in mcp_tool._server_connect_errors
        assert grace_key in mcp_tool._server_connecting
        assert grace_key in mcp_tool._parallel_safe_servers


@pytest.mark.asyncio
async def test_multiplex_reload_reports_lazy_survivor_without_touching_sibling(
    tmp_path, monkeypatch
):
    from agent import secret_scope
    from tests.hermes_cli.test_managed_mcp_profile_scope import _profile_scope
    from tools import mcp_tool

    runner = _make_runner_with_cached_agents(num_agents=0)
    runner.config.multiplex_profiles = True
    event = _make_event()
    event.source.profile = "eve"
    eve_home = (tmp_path / "profiles" / "eve").resolve()
    grace_home = (tmp_path / "profiles" / "grace").resolve()
    eve_home.mkdir(parents=True)
    grace_home.mkdir(parents=True)
    eve_owned = (str(eve_home), "gmail-owned")
    eve_shared = (str(eve_home), "gmail-shared")
    grace_owned = (str(grace_home), "drive-owned")
    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", True)
    runner._resolve_profile_home_for_source = lambda _source: eve_home

    def _scoped_shutdown():
        mcp_tool._lazy_server_tool_names.pop(eve_owned, None)
        mcp_tool._lazy_server_tool_names.pop(eve_shared, None)

    def _discover():
        mcp_tool._lazy_server_tool_names[eve_owned] = ["gmail_owned_read"]
        return ["gmail_owned_read"]

    try:
        with (
            patch.dict(mcp_tool._servers, {}, clear=True),
            patch.dict(
                mcp_tool._lazy_server_tool_names,
                {
                    eve_owned: ["gmail_owned_read"],
                    eve_shared: ["gmail_shared_read"],
                    grace_owned: ["drive_owned_read"],
                },
                clear=True,
            ),
            patch(
                "tools.mcp_tool.shutdown_mcp_servers_for_current_scope",
                side_effect=_scoped_shutdown,
            ),
            patch("tools.mcp_tool.discover_mcp_tools", side_effect=_discover),
            patch("model_tools.get_tool_definitions", return_value=[]),
        ):
            result = await runner._execute_mcp_reload(event)
            with _profile_scope(eve_home):
                available, connected = (
                    mcp_tool.get_mcp_server_inventory_for_current_profile()
                )

            assert available == {"gmail-owned"}
            assert connected == set()
            assert "Removed: gmail-shared" in result
            assert "Reconnected: gmail-owned" not in result
            assert "1 tool(s) available from 1 server(s)" in result
            assert "No MCP servers connected" not in result
            assert grace_owned in mcp_tool._lazy_server_tool_names
    finally:
        executor = getattr(runner, "_executor", None)
        if executor is not None:
            executor.shutdown(wait=True)
