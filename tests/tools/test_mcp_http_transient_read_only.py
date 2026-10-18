"""Read-only HTTP recovery uses one delayed replay and one logical breaker outcome."""

import asyncio
import json
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest

from tools import mcp_oauth_manager, mcp_tool, mcp_tool_handlers as handlers
from tools.mcp_tool_errors import _make_http_rejection_recorder
from tools.mcp_tool_scope import _server_key
from tools.registry import ToolRegistry


@pytest.fixture
def invoke(monkeypatch):
    sleep = Mock()
    auth = AsyncMock(return_value=False)
    monkeypatch.setattr(handlers.time, "sleep", sleep)
    monkeypatch.setattr(mcp_oauth_manager, "get_manager", lambda: SimpleNamespace(handle_401=auth))
    monkeypatch.setattr(handlers._loop, "_run_on_mcp_loop", lambda call, **kw: asyncio.run(call()))
    monkeypatch.setattr(handlers, "_trust_gate_check", lambda *a: None)
    key = _server_key("srv")
    monkeypatch.setattr(mcp_tool, "_server_error_counts", {})
    monkeypatch.setattr(mcp_tool, "_server_errors_all_application", {})
    monkeypatch.setattr(mcp_tool, "_server_breaker_opened_at", {})

    def run(*, status=502, method="POST", read_only=True, retry="success", failures=0):
        server = SimpleNamespace(_http_rejection={}, _rpc_lock=asyncio.Lock())
        recorder = _make_http_rejection_recorder(server._http_rejection)

        async def rpc(*args, **kwargs):
            if call_tool.await_count > 1 and retry != "raise":
                return SimpleNamespace(
                    content=[SimpleNamespace(type="text", text="ok")], isError=retry == "error")
            if status is not None:
                response = httpx.Response(
                    status, text="synthetic response body", headers={"content-type": "text/plain"},
                    request=httpx.Request(method, "https://provider.example/mcp"))
                await recorder(response)
                if status == 401:
                    raise httpx.HTTPStatusError("Unauthorized", request=response.request, response=response)
            exc = RuntimeError("Server returned an error response")
            exc.error = SimpleNamespace(code=-32603)
            raise ExceptionGroup("transport", [exc])

        call_tool = AsyncMock(side_effect=rpc)
        server.session = SimpleNamespace(call_tool=call_tool)
        monkeypatch.setattr(handlers, "_acquire_call_server", lambda *a: (server, None))
        monkeypatch.setattr(mcp_tool, "_tool_read_only_hints", {key: {"action": read_only}})
        mcp_tool._server_error_counts[key] = failures
        registry = ToolRegistry()
        registry.register("test_mcp_action", "mcp-srv", {}, handlers._make_tool_handler("srv", "action", 1))
        result = json.loads(registry.dispatch("test_mcp_action", {"payload": "synthetic argument"}))
        return result, call_tool, key

    return run, sleep, auth


@pytest.mark.parametrize("status", [502, 503, 504])
@pytest.mark.parametrize("retry", ["success", "raise", "error"])
def test_transient_read_only_has_one_retry_and_one_outcome(invoke, caplog, status, retry):
    run, sleep, auth = invoke
    failures = mcp_tool._CIRCUIT_BREAKER_THRESHOLD - 1 if retry == "success" else 0
    with caplog.at_level(logging.WARNING, logger="tools.mcp_tool"):
        result, call_tool, key = run(status=status, retry=retry, failures=failures)
    assert call_tool.await_count == 2
    assert call_tool.await_args_list[0] == call_tool.await_args_list[1]
    sleep.assert_called_once()
    assert 2 <= sleep.call_args.args[0] <= 5
    auth.assert_not_awaited()
    if retry == "success":
        assert result == {"result": "ok"}
        assert mcp_tool._server_error_counts[key] == 0
        assert key not in mcp_tool._server_breaker_opened_at
        assert handlers._check_circuit_breaker("srv") is None
    else:
        assert mcp_tool._server_error_counts[key] == 1
        if retry == "raise":
            assert result["error"].startswith("MCP call failed:")
            assert f"HTTP {status}" in result["error"]
        else:
            assert "error" in result
            assert mcp_tool._server_errors_all_application[key] is True
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    backoff = [line for line in warnings if "backing off" in line]
    assert len(backoff) == 1
    assert all(part in backoff[0] for part in ("srv", "tools/call action", str(status)))
    assert "synthetic argument" not in " ".join(warnings)
    assert "synthetic response body" not in " ".join(warnings)


@pytest.mark.parametrize("options", [
    {"status": 500}, {"status": 404}, {"status": 401}, {"status": None},
    {"method": "GET"}, {"read_only": False}, {"read_only": None}, {"read_only": "true"},
])
def test_ineligible_calls_do_not_transient_retry(invoke, options):
    run, sleep, auth = invoke
    result, call_tool, key = run(**options)
    assert call_tool.await_count == 1
    sleep.assert_not_called()
    assert mcp_tool._server_error_counts[key] == 1
    if options.get("status") == 401:
        assert result["needs_reauth"] is True
        auth.assert_awaited_once_with("srv", None)
    elif "read_only" in options:
        assert result["outcome_uncertain"] is True
        assert "may already have happened" in result["error"]
        auth.assert_not_awaited()
    else:
        assert result["error"].startswith("MCP call failed:")
        assert "outcome_uncertain" not in result
        auth.assert_not_awaited()
