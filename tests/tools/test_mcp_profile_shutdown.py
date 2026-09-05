"""Scoped MCP shutdown keeps another multiplex profile live."""

import asyncio
from pathlib import Path
from types import SimpleNamespace


def test_scoped_shutdown_only_clears_selected_profile_state(tmp_path: Path, monkeypatch):
    from agent import secret_scope
    from hermes_constants import hermes_home_key
    from tools import mcp_tool
    from tools import mcp_tool_lifecycle as lifecycle

    home_a, home_b = tmp_path / "profile-a", tmp_path / "profile-b"
    home_a.mkdir()
    home_b.mkdir()
    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", True)
    key_a = mcp_tool._server_state_key("shared", str(home_a))
    key_b = mcp_tool._server_state_key("shared", str(home_b))
    scope_a, scope_b = hermes_home_key(home_a), hermes_home_key(home_b)
    calls = []

    async def shutdown_a():
        calls.append("a")

    async def shutdown_b():
        calls.append("b")

    task_a = SimpleNamespace(name="shared", shutdown=shutdown_a)
    task_b = SimpleNamespace(name="shared", shutdown=shutdown_b)

    class _RunningLoop:
        @staticmethod
        def is_running():
            return True

    def schedule(coro, _loop, **_kwargs):
        result = asyncio.run(coro)
        return SimpleNamespace(result=lambda timeout=None: result)

    monkeypatch.setattr(mcp_tool, "_mcp_loop", _RunningLoop())
    monkeypatch.setattr(lifecycle._loop, "_stop_mcp_loop", lambda **_kwargs: None)
    monkeypatch.setattr("agent.async_utils.safe_schedule_threadsafe", schedule)
    try:
        with mcp_tool._lock:
            mcp_tool._servers.update({key_a: task_a, key_b: task_b})
            mcp_tool._server_scope_keys.update({key_a: scope_a, key_b: scope_b})
            mcp_tool._server_connect_retry_after.update({key_a: 1.0, key_b: 2.0})
            mcp_tool._server_connect_failures.update({key_a: 1, key_b: 2})

        lifecycle.shutdown_mcp_servers(scope=scope_a)

        with mcp_tool._lock:
            assert key_a not in mcp_tool._servers
            assert key_b in mcp_tool._servers
            assert key_a not in mcp_tool._server_connect_retry_after
            assert key_a not in mcp_tool._server_connect_failures
            assert mcp_tool._server_connect_retry_after[key_b] == 2.0
            assert mcp_tool._server_connect_failures[key_b] == 2
        assert calls == ["a"]

        lifecycle.shutdown_mcp_servers()
        with mcp_tool._lock:
            assert not mcp_tool._servers
            assert not mcp_tool._server_connect_retry_after
            assert not mcp_tool._server_connect_failures
        assert calls == ["a", "b"]
    finally:
        with mcp_tool._lock:
            mcp_tool._servers.clear()
            mcp_tool._server_scope_keys.clear()
            mcp_tool._server_connect_retry_after.clear()
            mcp_tool._server_connect_failures.clear()
