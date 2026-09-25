"""r34 intake: the managed MCP lease re-expressed on upstream's transport.

N1 lease client shape, N2 PCS-shaped lazy lease server.
"""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest

from tests.tools.test_evaos_mcp_lease import (
    DIRECT_ACCOUNT_ID,
    DIRECT_EXTERNAL_USER_ID,
    _direct_lease_payload,
    _Response,
    _write_secret,
)
from tools.evaos_mcp_lease import EvaosLeaseHttpAuth
from tools.mcp_tool import MCPServerTask


def _lease_env(tmp_path, monkeypatch):
    """Broker credential + runtime endpoint for one profile; returns (profile_home, mint_calls)."""
    from tools import evaos_mcp_lease as lease_module

    profile = tmp_path / "profile-test"
    credentials = tmp_path / "credentials"
    profile.mkdir()
    credentials.mkdir(mode=0o700)
    broker = credentials / "pipedream_broker"
    _write_secret(broker, "broker-secret-under-test\n")
    broker.chmod(0o400)
    monkeypatch.setenv("HERMES_HOME", str(profile))
    monkeypatch.setenv("CREDENTIALS_DIRECTORY", str(credentials))
    monkeypatch.setenv(
        "EVAOS_DESKTOP_RUNTIME_SESSION_URL",
        "https://example.supabase.co/functions/v1/desktop-runtime-session",
    )
    monkeypatch.setenv("PIPEDREAM_AGENT_BROKER_SECRET_FILE", str(broker))
    mint_calls = []

    async def mint(url, headers, payload):
        mint_calls.append((url, headers, payload))
        return _Response(200, _direct_lease_payload(datetime.now(timezone.utc) + timedelta(minutes=10)))

    monkeypatch.setattr(lease_module, "_default_transport", mint)
    return profile, mint_calls


def _pcs_config():
    """The exact key set PCS writes for one managed Pipedream app (profile identity mode)."""
    return {
        "auth": "evaos_lease",
        "app_slug": "google_sheets",
        "lazy": True,
        "account_id": DIRECT_ACCOUNT_ID,
        "external_user_id": DIRECT_EXTERNAL_USER_ID,
    }


@pytest.mark.asyncio
async def test_lease_client_has_no_proxy_mounts_no_redirects_no_sse_fallback(tmp_path, monkeypatch):
    """N1: a proxy in the environment never reaches the lease client, redirects are off, and a
    Streamable HTTP rejection does not fall back to SSE."""
    from tools import mcp_tool as mcp_tool_module

    profile, mint_calls = _lease_env(tmp_path, monkeypatch)
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.invalid:3128")
    monkeypatch.setenv("HTTP_PROXY", "http://proxy.invalid:3128")
    mounted = {}

    class Rejected(Exception):
        pass

    class CaptureTransport:
        async def __aenter__(self):
            raise Rejected("Server returned an error response (400)")

        async def __aexit__(self, *_exc):
            return False

    def capture_transport(url, *, http_client):
        mounted.update(
            url=url,
            mounts=dict(http_client._mounts),
            follow_redirects=http_client.follow_redirects,
            trust_env=http_client._trust_env,
            auth=http_client.auth,
        )
        return CaptureTransport()

    monkeypatch.setattr(mcp_tool_module, "_MCP_HTTP_AVAILABLE", True)
    monkeypatch.setattr(mcp_tool_module, "_MCP_NEW_HTTP", True)
    monkeypatch.setattr(mcp_tool_module, "streamable_http_client", capture_transport)

    config = _pcs_config()
    task = MCPServerTask("evaos-pipedream-google-sheets", str(profile))
    task._auth_type = "evaos_lease"
    task._validate_evaos_lease_config(config)
    with patch.object(MCPServerTask, "_sse_transport") as sse:
        with pytest.raises(Rejected):
            await task._run_http(config)

    sse.assert_not_called()
    assert len(mint_calls) == 1
    assert mounted["mounts"] == {}, "no proxy mount may carry the lease"
    assert mounted["follow_redirects"] is False
    assert mounted["trust_env"] is False
    assert isinstance(mounted["auth"], EvaosLeaseHttpAuth)


def test_pcs_shaped_lazy_lease_server_registers_from_cache_then_mints_on_first_call(tmp_path, monkeypatch):
    """N2: the PCS entry registers from the schema cache without connecting (status ``lazy``); the
    first tool call connects with that exact entry and mints a lease for it."""
    import tools.mcp_tool as core
    from tools import mcp_tool as mcp_tool_module
    from tools import mcp_tool_config as _config
    from tools import mcp_tool_discovery as discovery
    from tools import mcp_tool_handlers as handlers
    from tools import mcp_tool_loop as loop
    from tools.registry import registry

    profile, mint_calls = _lease_env(tmp_path, monkeypatch)
    name = "evaos-pipedream-google-sheets"
    config = _pcs_config()
    cache_entry = {
        "fingerprint": "fp",
        "tools": [{"name": "read_sheet", "description": "Read a sheet",
                   "inputSchema": {"type": "object", "properties": {}}}],
        "utility_tools": [],
    }
    connected_with = []

    class Mounted(Exception):
        pass

    class CaptureTransport:
        async def __aenter__(self):
            raise Mounted

        async def __aexit__(self, *_exc):
            return False

    async def first_call_connect(server_name, server_config):
        connected_with.append((server_name, dict(server_config)))
        task = MCPServerTask(server_name, str(profile))
        task._auth_type = server_config["auth"]
        task._validate_evaos_lease_config(server_config)
        with pytest.raises(Mounted):
            await task._run_http(server_config)
        raise ConnectionError("synthetic: transport captured after the lease mint")

    # The fleet pins approvals off; the native write-approval prompt is not what N2 exercises.
    from tools import approval_context
    monkeypatch.setattr(approval_context, "_get_approval_mode", lambda: "off")
    monkeypatch.setattr(mcp_tool_module, "_MCP_AVAILABLE", True)
    monkeypatch.setattr(mcp_tool_module, "_MCP_HTTP_AVAILABLE", True)
    monkeypatch.setattr(mcp_tool_module, "_MCP_NEW_HTTP", True)
    monkeypatch.setattr(mcp_tool_module, "streamable_http_client",
                        lambda url, *, http_client: CaptureTransport())
    monkeypatch.setattr(_config, "_filter_suspicious_mcp_servers", lambda servers: servers)
    monkeypatch.setattr(discovery, "_discover_and_register_server", first_call_connect)
    monkeypatch.setattr(loop, "_ensure_mcp_loop", lambda: None)
    monkeypatch.setattr(loop, "_run_on_mcp_loop",
                        lambda factory, timeout=30: asyncio.run(factory() if callable(factory) else factory))
    saved_lazy = dict(core._lazy_server_configs)
    try:
        with patch("tools.mcp_schema_cache.config_fingerprint", return_value="fp"), \
             patch("tools.mcp_schema_cache.get_cached_entry", return_value=cache_entry):
            registered = discovery.register_mcp_servers({name: config})
        tool_name = next(t for t in registered if t.endswith("read_sheet"))
        status = [s for s in discovery.get_mcp_status({name: config}) if s["name"] == name]
        assert status and status[0]["status"] == "lazy"
        assert not mint_calls, "registration from the cache must not mint a lease"

        out = registry.get_entry(tool_name).handler({})
        assert "error" in json.loads(out)
        assert connected_with == [(name, config)]
        assert mint_calls and mint_calls[0][2]["app_slug"] == "google_sheets"
        assert mint_calls[0][2]["account_id"] == DIRECT_ACCOUNT_ID
        assert mint_calls[0][2]["external_user_id"] == DIRECT_EXTERNAL_USER_ID
    finally:
        for tool in list(registry.get_tool_names_for_toolset(f"mcp-{name}")):
            registry.deregister(tool)
        core._lazy_server_configs.clear()
        core._lazy_server_configs.update(saved_lazy)
        core._lazy_server_fingerprints.pop(name, None)
        core._lazy_server_tool_names.pop(name, None)
        core._server_connect_errors.pop(name, None)
        core._server_connect_retry_after.pop(name, None)
        core._server_connect_failures.pop(name, None)
    del handlers
