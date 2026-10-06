"""Model-visible MCP rejection privacy and per-attempt attribution contracts."""

import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from tools import mcp_tool_handlers as handlers
from tools.mcp_tool_errors import _make_http_rejection_recorder


class SdkInternalError(Exception):
    def __init__(self):
        super().__init__("Server returned an error response")
        self.error = SimpleNamespace(code=-32603)


@pytest.fixture
def mcp_call(monkeypatch):
    from tools import mcp_tool

    server = SimpleNamespace(_http_rejection={}, _rpc_lock=asyncio.Lock())
    recorder = _make_http_rejection_recorder(server._http_rejection)

    async def rpc(tool_name, arguments):
        if arguments.get("status") is not None:
            async def record(response):
                if arguments.get("url_fallback"):
                    class UncopyableUrl:
                        def copy_with(self, **kwargs):
                            raise ValueError("cannot copy")

                        def __str__(self):
                            return arguments["url"]

                    response.request = SimpleNamespace(method="POST", url=UncopyableUrl())
                await recorder(response)

            async with httpx.AsyncClient(
                transport=httpx.MockTransport(lambda request: httpx.Response(
                    arguments["status"], text=arguments.get("body", ""),
                    headers={"content-type": "application/json"})),
                event_hooks={"response": [record]},
            ) as client:
                await client.post(arguments["url"])
        if arguments.get("fail", True):
            raise SdkInternalError()
        return SimpleNamespace(content=[SimpleNamespace(text="ok")], isError=False)

    server.session = SimpleNamespace(call_tool=rpc)
    monkeypatch.setattr(handlers._loop, "_run_on_mcp_loop", lambda call, **kw: asyncio.run(call()))
    monkeypatch.setattr(handlers, "_trust_gate_check", lambda *a: None)
    monkeypatch.setattr(handlers, "_check_circuit_breaker", lambda *a: None)
    monkeypatch.setattr(handlers, "_acquire_call_server", lambda *a: (server, None))
    monkeypatch.setattr(mcp_tool, "_bump_server_error", lambda *a, **kw: None)
    monkeypatch.setattr(mcp_tool, "_reset_server_error", lambda *a: None)
    return server, handlers._make_tool_handler("srv", "lookup", 1)


def test_mcp_rejection_text_preserves_diagnostics_without_credentials(mcp_call):
    server, call = mcp_call
    origin = "https://provider.example:8443"
    url = origin.replace("https://", "https://SYNTH_USER:SYNTH_PASS@") + (
        "/mcp/SYNTH_PATH?credential=SYNTH_QUERY#SYNTH_FRAGMENT")
    prefix = ('{"message":"route missing", "api_key":"SYNTH_PLAIN", '
              '"access_\\u0074oken":"SYNTH_ESCAPED\\\"tail", '
              '"secret\\q":"SYNTH_INVALID_ESCAPE", "password":"SYNTH_LONG')
    # The bounded read ends on an escape, before the sensitive value's closing quote.
    body = prefix + "x" * (65535 - len(prefix)) + '\\"tail"}'
    # Parsed JSON: any value type under a sensitive key, at any depth.
    nested = json.dumps({"message": "route missing", "credential": {"value": "SYNTH_NESTED"},
                         "session_id": 987654321, "items": [{"api_key": "SYNTH_LIST"}],
                         "private_key": "SYNTH_PK", "auth": "SYNTH_AUTH", "key": "SYNTH_KEY",
                         "jwt": "SYNTH_JWT"})
    # Unparseable JSON: a sensitive key owning an object hides everything after it.
    broken = '{"message": "route missing", "credential": {"value": "SYNTH_BROKEN"} BROKEN'
    # Not JSON: form-encoded and header-style echoes.
    plain = ("route missing: error=invalid_grant&access_token=SYNTH_FORM&client_secret=SYNTH_FORM2 "
             "Authorization: Bearer SYNTH_BEARER X-Api-Key: SYNTH_HEADER Cookie: session=SYNTH_C1; refresh=SYNTH_C2")
    for status, fallback, body in ((400, False, body), (503, True, body), (401, False, nested), (403, True, plain),
                                  (422, False, broken)):
        error = json.loads(call({"status": status, "url": url, "body": body,
                                 "url_fallback": fallback}))["error"]
        assert f"HTTP {status} from POST {origin}:" in error
        assert "route missing" in error
        assert "[REDACTED]" in error
        assert "/mcp/" not in error
        assert "SYNTH_" not in error and "987654321" not in error
        assert server._http_rejection["url"] == origin


def test_mcp_rejection_detail_belongs_only_to_its_own_failed_attempt(mcp_call):
    server, call = mcp_call
    own = json.loads(call({"status": 404, "url": "https://provider.example/mcp",
                           "body": "route missing"}))["error"]
    recorded = dict(server._http_rejection)
    stale = json.loads(call({}))["error"]
    success = json.loads(call({"status": 200, "url": "https://provider.example/mcp",
                               "fail": False}))
    assert stale == "MCP call failed: SdkInternalError: Server returned an error response"
    assert "HTTP 404 from POST https://provider.example: route missing" in own
    assert success == {"result": "ok"}
    assert server._http_rejection == recorded
