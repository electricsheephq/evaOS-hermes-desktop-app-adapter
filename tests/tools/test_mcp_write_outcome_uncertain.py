"""Regression for adapter#405: an HTTP error may follow a completed write."""

import asyncio
import json
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from tools import mcp_tool, mcp_tool_handlers as handlers
from tools.mcp_tool_errors import _make_http_rejection_recorder
from tools.mcp_tool_scope import _server_key
from tools.registry import ToolRegistry


@pytest.fixture
def invoke(monkeypatch):
    def run(*, status=None, method="POST", stale=False, read_only=False, fail=True, opaque=True):
        server = SimpleNamespace(_http_rejection={}, _rpc_lock=asyncio.Lock())
        recorder = _make_http_rejection_recorder(server._http_rejection)

        async def reject():
            await recorder(httpx.Response(
                status, text="synthetic response body", headers={"content-type": "text/plain"},
                request=httpx.Request(method, "https://provider.example/mcp")))

        async def rpc(*args, **kwargs):
            if status is not None and not stale:
                await reject()
            if fail:
                exc = RuntimeError("Server returned an error response" if opaque else "unrelated failure")
                if opaque:
                    exc.error = SimpleNamespace(code=-32603)
                raise ExceptionGroup("transport", [exc])
            return SimpleNamespace(content=[SimpleNamespace(type="text", text="ok")], isError=False)

        if stale:
            asyncio.run(reject())
        call_tool = AsyncMock(side_effect=rpc)
        server.session = SimpleNamespace(call_tool=call_tool)
        key = _server_key("srv")
        monkeypatch.setattr(mcp_tool, "_tool_read_only_hints", {key: {"action": read_only}})
        monkeypatch.setattr(mcp_tool, "_server_error_counts", {})
        monkeypatch.setattr(mcp_tool, "_server_errors_all_application", {})
        monkeypatch.setattr(mcp_tool, "_server_breaker_opened_at", {})
        monkeypatch.setattr(handlers._loop, "_run_on_mcp_loop", lambda call, **kw: asyncio.run(call()))
        monkeypatch.setattr(handlers, "_trust_gate_check", lambda *a: None)
        monkeypatch.setattr(handlers, "_acquire_call_server", lambda *a: (server, None))
        registry = ToolRegistry()
        registry.register("test_mcp_action", "mcp-srv", {}, handlers._make_tool_handler("srv", "action", 1))
        result = json.loads(registry.dispatch("test_mcp_action", {"payload": "synthetic argument"}))
        assert call_tool.await_count == 1
        assert mcp_tool._server_error_counts[key] == int(fail)
        return result

    return run


def test_write_post_502_is_uncertain_without_replay(invoke, caplog):
    with caplog.at_level(logging.WARNING, logger="tools.mcp_tool"):
        result = invoke(status=502)
    assert result["outcome_uncertain"] is True
    assert result["server"] == "srv"
    assert "HTTP 502" in result["error"] and "may already have happened" in result["error"]
    assert "before retrying" in result["error"]
    assert "synthetic response body" in result["error"]  # the server's own words still reach the model
    warnings = [r for r in caplog.records if r.name == "tools.mcp_tool"]
    assert len(warnings) == 1 and warnings[0].levelno == logging.WARNING
    assert "synthetic argument" not in warnings[0].getMessage()
    assert "synthetic response body" not in warnings[0].getMessage()


@pytest.mark.parametrize("options", [
    {"status": 502, "stale": True, "opaque": False},
    {"status": 502, "stale": True},
    {"status": 502, "stale": True, "fail": False},
    {"status": 502, "read_only": True},
    {"status": 400},
    {"status": 502, "method": "GET"},
    {"status": 502, "opaque": False},
    {},
])
def test_other_call_outcomes_keep_existing_behavior(invoke, options):
    result = invoke(**options)
    assert "outcome_uncertain" not in result
    if options.get("fail", True):
        assert result["error"].startswith("MCP call failed:")
        if options.get("stale"):
            assert "HTTP" not in result["error"]
    else:
        assert result == {"result": "ok"}
