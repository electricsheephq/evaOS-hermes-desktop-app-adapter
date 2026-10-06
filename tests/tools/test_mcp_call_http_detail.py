"""Per-attempt MCP HTTP rejection diagnostics, with credential redaction."""

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from tools import mcp_tool_handlers as handlers
from tools.mcp_tool_errors import (
    _HTTP_REJECTION_BODY_CHARS,
    _capture_http_rejection,
    _describe_http_failure,
    _http_rejection_detail,
    _make_http_rejection_recorder,
    _redact_rejection_body,
)


class SdkInternalError(Exception):
    def __init__(self):
        super().__init__("Server returned an error response")
        self.error = SimpleNamespace(code=-32603)


class EmptyMsg(Exception):
    def __str__(self):
        return ""


def _response(body="route missing", status=404):
    return httpx.Response(
        status, text=body, headers={"content-type": "application/json"},
        request=httpx.Request("POST", "https://host/path?auth=SYNTH&token=SYNTH2#SYNTH3"))


def test_mcp_recorder_redacts_credentials_before_storing_and_sequences_records():
    sensitive = {key: "SYNTH_" + key for key in (
        "access_token", "refresh_token", "client_secret", "api_key", "password")}
    payload = {**sensitive, "message": "route missing", "code": 404}
    sink = {}

    async def record():
        recorder = _make_http_rejection_recorder(sink)
        await recorder(_response(json.dumps(payload)))
        first = dict(sink)
        await recorder(_response())
        return first

    first = asyncio.run(record())
    assert first["url"] == "https://host/path"
    assert all(value not in first["body"] for value in sensitive.values())
    assert json.loads(first["body"]) == {
        **dict.fromkeys(sensitive, "[REDACTED]"), "message": "route missing", "code": 404}
    assert sink["seq"] > first["seq"]
    detail = _describe_http_failure(SdkInternalError(), first)
    assert "route missing" in detail and "SYNTH" not in detail


@pytest.mark.parametrize("key", [
    "ACCESS_TOKEN", "x-api-key", "apikey", "passwd", "Authorization", "credential",
    "client-secret", "session_id", "session-id", "cookie", "mySecret", "access_\\u0074oken",
])
def test_mcp_body_redaction_matches_sensitive_substrings_and_escaped_strings(key):
    text = '"' + key + '": "SYNTH\\\"value", "message": "route missing"'
    assert _redact_rejection_body(text) == (
        '"' + key + '": "[REDACTED]", "message": "route missing"')
    assert _redact_rejection_body("token=SYNTH") == "[REDACTED]"


def test_mcp_recorder_redacts_long_values_before_truncation_and_has_url_fallback():
    sink = {}
    response = _response(json.dumps({
        "access_token": "SYNTH" * (_HTTP_REJECTION_BODY_CHARS * 5), "message": "safe"}))

    class UncopyableUrl:
        def copy_with(self, **kwargs):
            raise ValueError("cannot copy")

        def __str__(self):
            return "https://host/path#SYNTH3?auth=SYNTH"

    response.request = SimpleNamespace(method="POST", url=UncopyableUrl())
    asyncio.run(_make_http_rejection_recorder(sink)(response))
    assert sink["url"] == "https://host/path"
    assert json.loads(sink["body"]) == {"access_token": "[REDACTED]", "message": "safe"}
    assert len(sink["body"]) <= _HTTP_REJECTION_BODY_CHARS


@pytest.mark.parametrize("mode", ["fresh", "stale", "rebound", "absent"])
def test_mcp_capture_only_attaches_a_new_record_from_the_entered_sink(mode):
    server = SimpleNamespace(_http_rejection={}) if mode != "absent" else SimpleNamespace()
    exc = SdkInternalError()

    async def fail():
        if mode == "stale":
            await _make_http_rejection_recorder(server._http_rejection)(_response())
        async with _capture_http_rejection(server):
            if mode == "rebound":
                server._http_rejection = {}
            if mode in {"fresh", "rebound"}:
                await _make_http_rejection_recorder(server._http_rejection)(_response())
            raise exc

    with pytest.raises(SdkInternalError) as raised:
        asyncio.run(fail())
    assert raised.value is exc
    if mode == "fresh":
        assert exc._mcp_http_rejection == server._http_rejection
        assert exc._mcp_http_rejection is not server._http_rejection
    else:
        assert not hasattr(exc, "_mcp_http_rejection")


def test_mcp_capture_success_does_not_change_the_sink():
    server = SimpleNamespace(_http_rejection={"seq": 1, "status": 404})

    async def succeed():
        async with _capture_http_rejection(server):
            return "ok"

    assert asyncio.run(succeed()) == "ok"
    assert server._http_rejection == {"seq": 1, "status": 404}


@pytest.mark.parametrize("exc_type", [asyncio.CancelledError, KeyboardInterrupt])
def test_mcp_capture_base_exceptions_pass_through_without_snapshot(exc_type):
    server = SimpleNamespace(_http_rejection={})
    exc = exc_type()

    async def fail():
        async with _capture_http_rejection(server):
            await _make_http_rejection_recorder(server._http_rejection)(_response())
            raise exc

    with pytest.raises(exc_type) as raised:
        asyncio.run(fail())
    assert raised.value is exc
    assert not hasattr(exc, "_mcp_http_rejection")


@pytest.fixture
def inline_mcp_loop(monkeypatch):
    monkeypatch.setattr(handlers._loop, "_run_on_mcp_loop", lambda call, **kw: asyncio.run(call()))


@pytest.mark.parametrize("kind", ["opaque", "group", "plain", "empty"])
def test_mcp_dispatch_formats_only_opaque_errors_and_preserves_repr(inline_mcp_loop, kind):
    exc = {"opaque": SdkInternalError(), "group": ExceptionGroup("rpc", [SdkInternalError()]),
           "plain": ValueError("ordinary failure"), "empty": EmptyMsg()}[kind]
    server = SimpleNamespace(_http_rejection={}, _rpc_lock=asyncio.Lock())

    async def call():
        async with server._rpc_lock, _capture_http_rejection(server):
            await _make_http_rejection_recorder(server._http_rejection)(_response())
            raise exc

    error = json.loads(handlers._dispatch(
        "srv", server, "tools/call", call, 1, (), lambda exc: None))["error"]
    assert error.startswith(f"MCP call failed: {type(exc).__name__}: ")
    if kind in {"opaque", "group"}:
        assert "HTTP 404 from POST https://host/path: route missing" in error
        assert "SYNTH" not in error
    else:
        assert "HTTP" not in error
    if kind == "empty":
        assert "EmptyMsg: EmptyMsg()" in error


@pytest.mark.parametrize("clear", [False, True])
def test_mcp_call_snapshot_and_final_text_survive_another_calls_sink_change(inline_mcp_loop, clear):
    server = SimpleNamespace(_http_rejection={}, _rpc_lock=asyncio.Lock())
    exc = SdkInternalError()
    snapshots = []

    async def call():
        async with server._rpc_lock, _capture_http_rejection(server):
            await _make_http_rejection_recorder(server._http_rejection)(_response())
            raise exc

    def other_call(failed):
        assert failed is exc
        snapshots.append(dict(failed._mcp_http_rejection))
        if clear:
            server._http_rejection.clear()
        else:
            server._http_rejection.update(status=503, body="another call failed", seq=-1)

    error = json.loads(handlers._dispatch(
        "srv", server, "tools/call", call, 1, (), other_call))["error"]
    assert exc._mcp_http_rejection == snapshots[0]
    assert "HTTP 404 from POST https://host/path: route missing" in error
    assert "503" not in error and "another call" not in error
    assert _http_rejection_detail(exc, {"method": "POST"}) == ""


@pytest.mark.parametrize("utility", [False, True], ids=["tool", "utility"])
def test_mcp_handler_factories_capture_the_rpc_failure(monkeypatch, inline_mcp_loop, utility):
    from tools import mcp_tool
    from tools import mcp_tool_discovery as discovery

    server = SimpleNamespace(_http_rejection={}, _rpc_lock=asyncio.Lock(), session=object())

    async def rpc(*args, **kwargs):
        assert server._rpc_lock.locked()
        await _make_http_rejection_recorder(server._http_rejection)(_response())
        raise SdkInternalError()

    monkeypatch.setattr(handlers, "_handle_auth_error_and_retry", lambda *a: None)
    monkeypatch.setattr(handlers, "_handle_session_expired_and_retry", lambda *a, **kw: None)
    if utility:
        monkeypatch.setattr(discovery, "_get_connected_server_for_call", lambda name: server)
        handler = handlers._make_utility_handler("resources/read", "read", rpc, lambda *a: {})("srv", 1)
    else:
        monkeypatch.setattr(handlers, "_trust_gate_check", lambda *a: None)
        monkeypatch.setattr(handlers, "_check_circuit_breaker", lambda *a: None)
        monkeypatch.setattr(handlers, "_acquire_call_server", lambda *a: (server, None))
        monkeypatch.setattr(handlers, "_call_tool_racing_stdio_death", rpc)
        monkeypatch.setattr(mcp_tool, "_bump_server_error", lambda *a: None)
        handler = handlers._make_tool_handler("srv", "lookup", 1)
    assert "HTTP 404 from POST https://host/path: route missing" in json.loads(handler({}))["error"]
