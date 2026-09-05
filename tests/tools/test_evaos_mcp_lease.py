"""Managed evaOS MCP lease authentication and refresh behavior."""

from __future__ import annotations

import asyncio
import os
import tomllib
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from tools.evaos_mcp_lease import (
    EvaosLeaseError,
    EvaosLeaseHttpAuth,
    EvaosLeaseManager,
    EvaosLeaseSource,
)
from tools.mcp_schema_cache import config_fingerprint
from tools.mcp_tool import MCPServerTask, sdk_httpx


httpx = sdk_httpx()


def test_lease_auth_binds_to_the_sdk_http_stack():
    assert httpx.__name__ == "httpx2"
    assert issubclass(EvaosLeaseHttpAuth, httpx.Auth)


@pytest.mark.asyncio
async def test_broker_mint_transport_ignores_proxy_environment(monkeypatch):
    from tools import evaos_mcp_lease as lease_module

    observed = {}

    class Client:
        def __init__(self, **kwargs):
            observed.update(kwargs)

        async def __aenter__(self):
            return self

        async def __aexit__(self, _exc_type, _exc, _tb):
            return False

        async def post(self, url, *, headers, json):
            observed.update(url=url, headers=headers, payload=json)
            return _Response(200, {})

    monkeypatch.setenv("HTTPS_PROXY", "https://profile-proxy.invalid")
    monkeypatch.setenv("SSL_CERT_FILE", "/profile-controlled/ca.pem")
    monkeypatch.setattr(lease_module._SDK_HTTPX, "AsyncClient", Client)

    await lease_module._default_transport(
        "https://example.supabase.co/functions/v1/desktop-runtime-session",
        {"X-Test": "redacted"},
        {"action": "pipedream_mcp_lease", "app_slug": "google_sheets"},
    )

    assert observed["trust_env"] is False
    assert observed["follow_redirects"] is False

class _Response:
    def __init__(self, status_code: int, payload: dict, *, text: str = ""):
        self.status_code = status_code
        self._payload = payload
        self.text = text

    def json(self):
        return self._payload


def _write_secret(path, value: str):
    path.write_text(value, encoding="utf-8")
    path.chmod(0o600)


def _source(tmp_path, *, app_slug="google_sheets", profile_key="profile-a"):
    broker = tmp_path / "broker"
    _write_secret(broker, "broker-secret-under-test\n")
    values = {
        "EVAOS_DESKTOP_RUNTIME_SESSION_URL": (
            "https://example.supabase.co/functions/v1/desktop-runtime-session"
        ),
        "PIPEDREAM_AGENT_BROKER_SECRET_FILE": str(broker),
    }
    source = EvaosLeaseSource(
        profile_key=profile_key,
        app_slug=app_slug,
        secret_reader=values.get,
        profile_resolver=lambda: profile_key,
        root_uid=os.getuid(),
    )
    return source, broker


def _lease_payload(expires_at: datetime, token="lease-token-1"):
    return {
        "mcp_url": "https://remote.mcp.pipedream.net/v3",
        "headers": {
            "Authorization": f"Bearer {token}",
            "x-pd-project-id": "proj",
            "x-pd-environment": "production",
            "x-pd-external-user-id": "server-derived",
            "x-pd-app-slug": "google_sheets",
            "x-pd-account-id": "apn_test_server_resolved",
        },
        "expires_at": expires_at.isoformat(),
    }


def test_source_defaults_service_uid_to_root_uid_without_geteuid(
    monkeypatch,
):
    monkeypatch.delattr(os, "geteuid", raising=False)

    source = EvaosLeaseSource(
        profile_key="profile-a",
        app_slug="google_sheets",
        secret_reader=lambda _name: None,
        profile_resolver=lambda: "profile-a",
        root_uid=4321,
    )

    assert source._service_uid == 4321


@pytest.mark.asyncio
async def test_lease_request_uses_only_root_configured_profile_route(tmp_path):
    now = datetime(2026, 8, 8, tzinfo=timezone.utc)
    source, _ = _source(tmp_path)
    calls = []
    settings_read = []
    original_reader = source._secret_reader
    source._secret_reader = lambda name: (
        settings_read.append(name) or original_reader(name)
    )

    async def transport(url, headers, payload):
        calls.append((url, headers, payload))
        return _Response(200, _lease_payload(now + timedelta(minutes=10)))

    manager = EvaosLeaseManager(
        source=source,
        transport=transport,
        now=lambda: now,
    )
    lease = await manager.get_lease()

    assert lease.mcp_url == "https://remote.mcp.pipedream.net/v3"
    assert calls[0][2] == {
        "action": "pipedream_mcp_lease",
        "app_slug": "google_sheets",
    }
    # adapter#89: no per-app grant handle is sent, and the grant-file setting is
    # never even looked up. Pipedream Connect MCP requires no such handle, and
    # the compat edge fn derives x-pd-external-user-id server-side.
    assert "X-Evaos-Provider-Grant" not in calls[0][1]
    assert "PIPEDREAM_PROVIDER_GRANT_FILE" not in settings_read
    assert not {
        "account_id",
        "profile",
        "profile_id",
        "external_user_id",
        "project_id",
        "environment",
    } & calls[0][2].keys()


@pytest.mark.asyncio
async def test_expiry_refreshes_before_skew(tmp_path):
    clock = [datetime(2026, 8, 8, tzinfo=timezone.utc)]
    source, _ = _source(tmp_path)
    calls = 0

    async def transport(url, headers, payload):
        nonlocal calls
        calls += 1
        return _Response(
            200,
            _lease_payload(
                clock[0] + timedelta(seconds=90),
                token=f"lease-token-{calls}",
            ),
        )

    manager = EvaosLeaseManager(
        source=source,
        transport=transport,
        now=lambda: clock[0],
        refresh_skew_seconds=60,
    )
    first = await manager.get_lease()
    clock[0] += timedelta(seconds=31)
    second = await manager.get_lease()

    assert first.authorization != second.authorization
    assert calls == 2


@pytest.mark.asyncio
async def test_concurrent_refresh_is_single_flight(tmp_path):
    now = datetime(2026, 8, 8, tzinfo=timezone.utc)
    source, _ = _source(tmp_path)
    entered = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def transport(url, headers, payload):
        nonlocal calls
        calls += 1
        entered.set()
        await release.wait()
        return _Response(200, _lease_payload(now + timedelta(minutes=10)))

    manager = EvaosLeaseManager(
        source=source,
        transport=transport,
        now=lambda: now,
    )
    tasks = [asyncio.create_task(manager.get_lease()) for _ in range(8)]
    await entered.wait()
    release.set()
    leases = await asyncio.gather(*tasks)

    assert calls == 1
    assert len({lease.authorization for lease in leases}) == 1


@pytest.mark.asyncio
async def test_http_auth_refreshes_and_retries_exactly_once_after_401(tmp_path):
    now = datetime(2026, 8, 8, tzinfo=timezone.utc)
    source, _ = _source(tmp_path)
    calls = 0

    async def transport(url, headers, payload):
        nonlocal calls
        calls += 1
        assert "X-Evaos-Provider-Grant" not in headers
        return _Response(
            200,
            _lease_payload(
                now + timedelta(minutes=10),
                token=f"lease-token-{calls}",
            ),
        )

    manager = EvaosLeaseManager(
        source=source,
        transport=transport,
        now=lambda: now,
    )
    auth = EvaosLeaseHttpAuth(manager)
    request = httpx.Request(
        "POST",
        "https://remote.mcp.pipedream.net/v3",
        json={"jsonrpc": "2.0"},
    )
    flow = auth.async_auth_flow(request)

    first = await anext(flow)
    assert first.headers["Authorization"] == "Bearer lease-token-1"
    second = await flow.asend(httpx.Response(401, request=first))
    assert second.headers["Authorization"] == "Bearer lease-token-2"
    assert calls == 2
    with pytest.raises(StopAsyncIteration):
        await flow.asend(httpx.Response(401, request=second))
    assert calls == 2


@pytest.mark.asyncio
async def test_lease_mint_401_surfaces_sanitized_server_body(tmp_path):
    now = datetime(2026, 8, 8, tzinfo=timezone.utc)
    source, _ = _source(tmp_path)

    async def transport(url, headers, payload):
        return _Response(401, {}, text="Pipedream MCP grant is required")

    manager = EvaosLeaseManager(source=source, transport=transport, now=lambda: now)
    with pytest.raises(EvaosLeaseError) as caught:
        await manager.get_lease()

    assert str(caught.value) == (
        "managed MCP lease rejected (401): Pipedream MCP grant is required"
    )


@pytest.mark.asyncio
async def test_lease_mint_redacts_compact_json_credentials(tmp_path):
    now = datetime(2026, 8, 8, tzinfo=timezone.utc)
    source, _ = _source(tmp_path)

    async def transport(url, headers, payload):
        return _Response(
            401,
            {},
            text=(
                '{"Authorization":"lease-token-under-test",'
                '"x-api-key":"api-key-under-test",'
                '"access_token":"access-token-under-test",'
                '"refresh_token":"refresh-token-under-test"}'
            ),
        )

    manager = EvaosLeaseManager(source=source, transport=transport, now=lambda: now)
    with pytest.raises(EvaosLeaseError) as caught:
        await manager.get_lease()

    detail = str(caught.value)
    assert "lease-token-under-test" not in detail
    assert "api-key-under-test" not in detail
    assert "access-token-under-test" not in detail
    assert "refresh-token-under-test" not in detail
    assert "[redacted]" in detail


def test_source_rejects_cross_profile_and_unsafe_files(tmp_path):
    source, broker = _source(tmp_path)
    source._profile_resolver = lambda: "profile-b"
    with pytest.raises(EvaosLeaseError, match="profile authority"):
        source.read()

    source._profile_resolver = lambda: "profile-a"
    broker.chmod(0o644)
    with pytest.raises(EvaosLeaseError, match="secure managed credential"):
        source.read()


@pytest.mark.parametrize("mode", [0o400, 0o440])
def test_source_accepts_systemd_loadcredential_copy(
    tmp_path,
    monkeypatch,
    mode,
):
    credentials = tmp_path / "credentials"
    credentials.mkdir(mode=0o700)
    broker = credentials / "pipedream_broker"
    _write_secret(broker, "broker-secret-under-test\n")
    broker.chmod(mode)
    monkeypatch.setenv("CREDENTIALS_DIRECTORY", str(credentials))
    values = {
        "EVAOS_DESKTOP_RUNTIME_SESSION_URL": (
            "https://example.supabase.co/functions/v1/desktop-runtime-session"
        ),
        "PIPEDREAM_AGENT_BROKER_SECRET_FILE": str(broker),
    }
    source = EvaosLeaseSource(
        profile_key="profile-a",
        app_slug="google_sheets",
        secret_reader=values.get,
        profile_resolver=lambda: "profile-a",
        root_uid=os.getuid(),
        service_uid=os.getuid(),
    )

    material = source.read()

    assert material.app_slug == "google_sheets"


def test_source_accepts_service_owned_0400_systemd_copy(
    tmp_path,
    monkeypatch,
):
    credentials = tmp_path / "credentials"
    credentials.mkdir(mode=0o700)
    broker = credentials / "pipedream_broker"
    _write_secret(broker, "broker-secret-under-test\n")
    broker.chmod(0o400)
    monkeypatch.setenv("CREDENTIALS_DIRECTORY", str(credentials))
    values = {
        "EVAOS_DESKTOP_RUNTIME_SESSION_URL": (
            "https://example.supabase.co/functions/v1/desktop-runtime-session"
        ),
        "PIPEDREAM_AGENT_BROKER_SECRET_FILE": "%d/pipedream_broker",
    }
    source = EvaosLeaseSource(
        profile_key="profile-a",
        app_slug="google_sheets",
        secret_reader=values.get,
        profile_resolver=lambda: "profile-a",
        root_uid=os.getuid() + 1000,
        service_uid=os.getuid(),
    )

    material = source.read()

    assert material.app_slug == "google_sheets"


def test_source_rejects_0400_outside_systemd_credential_directory(tmp_path):
    source, broker = _source(tmp_path)
    broker.chmod(0o400)

    with pytest.raises(EvaosLeaseError, match="secure managed credential"):
        source.read()


def test_source_rejects_unsafe_systemd_credential_pointer(tmp_path, monkeypatch):
    source, _ = _source(tmp_path)
    monkeypatch.setenv("CREDENTIALS_DIRECTORY", str(tmp_path))
    original_reader = source._secret_reader
    source._secret_reader = lambda name: (
        "%d/../broker-secret"
        if name == "PIPEDREAM_AGENT_BROKER_SECRET_FILE"
        else original_reader(name)
    )

    with pytest.raises(EvaosLeaseError, match="systemd credential pointer"):
        source.read()


def test_source_rejects_symlinked_secret_file(tmp_path):
    source, broker = _source(tmp_path)
    target = tmp_path / "broker-target"
    broker.rename(target)
    broker.symlink_to(target)

    with pytest.raises(EvaosLeaseError, match="broker secret file"):
        source.read()


def test_runtime_endpoint_and_broker_path_stay_global(monkeypatch):
    from agent import secret_scope

    monkeypatch.setenv(
        "EVAOS_DESKTOP_RUNTIME_SESSION_URL",
        "https://global.example/functions/v1/desktop-runtime-session",
    )
    monkeypatch.setenv(
        "PIPEDREAM_AGENT_BROKER_SECRET_FILE",
        "/global/broker",
    )
    monkeypatch.setenv(
        "CREDENTIALS_DIRECTORY",
        "/run/credentials/evaos-shared-gateway.service",
    )
    token = secret_scope.set_secret_scope(
        {
            "CREDENTIALS_DIRECTORY": "/wrong/profile/credentials",
        }
    )
    secret_scope.set_multiplex_active(True)
    try:
        assert secret_scope.get_secret(
            "EVAOS_DESKTOP_RUNTIME_SESSION_URL"
        ).startswith("https://global.example/")
        assert secret_scope.get_secret(
            "PIPEDREAM_AGENT_BROKER_SECRET_FILE"
        ) == "/global/broker"
        assert secret_scope.get_secret("CREDENTIALS_DIRECTORY") == (
            "/run/credentials/evaos-shared-gateway.service"
        )
    finally:
        secret_scope.reset_secret_scope(token)
        secret_scope.set_multiplex_active(False)


def test_source_rejects_non_supabase_lease_endpoint(tmp_path):
    source, _ = _source(tmp_path)
    original_reader = source._secret_reader
    source._secret_reader = lambda name: (
        "https://attacker.example/functions/v1/desktop-runtime-session"
        if name == "EVAOS_DESKTOP_RUNTIME_SESSION_URL"
        else original_reader(name)
    )

    with pytest.raises(EvaosLeaseError, match="lease endpoint"):
        source.read()


@pytest.mark.asyncio
async def test_errors_and_repr_never_expose_tokens(tmp_path, caplog):
    now = datetime(2026, 8, 8, tzinfo=timezone.utc)
    source, _ = _source(tmp_path)
    secret = "server-body-secret-that-must-not-escape"

    async def transport(url, headers, payload):
        return _Response(403, {"error": secret})

    manager = EvaosLeaseManager(
        source=source,
        transport=transport,
        now=lambda: now,
    )
    with pytest.raises(EvaosLeaseError) as caught:
        await manager.get_lease()

    rendered = str(caught.value) + caplog.text + repr(manager)
    assert secret not in rendered
    assert "broker-secret-under-test" not in rendered


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutate",
    [
        lambda payload, now: payload.update(
            mcp_url="https://attacker.example/v3"
        ),
        lambda payload, now: payload["headers"].update(
            {"x-extra-credential": "must-not-be-forwarded"}
        ),
        lambda payload, now: payload["headers"].update(
            {"x-pd-app-slug": "google_drive"}
        ),
        lambda payload, now: payload["headers"].update(
            {"x-pd-account-id": "legacy_account"}
        ),
        lambda payload, now: payload["headers"].update(
            {"Authorization": "Bearer injected\r\nX-Leak: value"}
        ),
        lambda payload, now: payload.update(
            expires_at=(now + timedelta(seconds=30)).isoformat()
        ),
        lambda payload, now: payload.update(extra="unexpected"),
    ],
)
async def test_lease_response_is_strictly_validated(tmp_path, mutate):
    now = datetime(2026, 8, 8, tzinfo=timezone.utc)
    source, _ = _source(tmp_path)
    payload = _lease_payload(now + timedelta(minutes=10))
    mutate(payload, now)

    async def transport(url, headers, request_payload):
        return _Response(200, payload)

    manager = EvaosLeaseManager(
        source=source,
        transport=transport,
        now=lambda: now,
    )

    with pytest.raises(EvaosLeaseError, match="lease response|expires too soon"):
        await manager.get_lease()


def test_managed_lease_config_is_http_without_a_static_url():
    task = MCPServerTask("pipedream-google-sheets")
    task._config = {
        "auth": "evaos_lease",
        "app_slug": "google_sheets",
        "lazy": True,
    }
    task._auth_type = "evaos_lease"

    task._validate_evaos_lease_config(task._config)

    assert task._is_http() is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "identity",
    [
        {},
        {
            "customer_id": "customer-fixture",
            "agent_runtime": "hermes",
            "agent_id": "agent-fixture",
        },
    ],
    ids=["thin", "identity-keyed"],
)
async def test_managed_config_mounts_through_r5_lease(
    tmp_path, monkeypatch, identity
):
    from tools import evaos_mcp_lease as lease_module
    from tools import mcp_tool as mcp_tool_module

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
    # adapter#89 regression: NO grant file exists and no grant setting is set.
    monkeypatch.delenv("PIPEDREAM_PROVIDER_GRANT_FILE", raising=False)
    assert not (credentials / "pipedream_grants").exists()

    mint_calls = []

    async def mint(url, headers, payload):
        mint_calls.append((url, headers, payload))
        return _Response(
            200,
            _lease_payload(
                datetime.now(timezone.utc) + timedelta(minutes=10)
            ),
        )

    monkeypatch.setattr(lease_module, "_default_transport", mint)

    mounted = {}

    class Mounted(Exception):
        pass

    class CaptureTransport:
        async def __aenter__(self):
            raise Mounted

        async def __aexit__(self, _exc_type, _exc, _tb):
            return False

    def capture_transport(url, *, http_client):
        mounted.update(
            url=url,
            headers=http_client.headers,
            auth=http_client.auth,
            trust_env=http_client._trust_env,
        )
        return CaptureTransport()

    monkeypatch.setattr(mcp_tool_module, "_MCP_HTTP_AVAILABLE", True)
    monkeypatch.setattr(mcp_tool_module, "_MCP_NEW_HTTP", True)
    monkeypatch.setattr(
        mcp_tool_module, "streamable_http_client", capture_transport
    )

    config = {
        "auth": "evaos_lease",
        "app_slug": "google_sheets",
        "lazy": True,
        **identity,
    }
    task = MCPServerTask("pipedream-google-sheets", str(profile))
    task._auth_type = "evaos_lease"
    task._validate_evaos_lease_config(config)

    with pytest.raises(Mounted):
        await task._run_http(config)

    assert mint_calls[0][2] == {
        "action": "pipedream_mcp_lease",
        "app_slug": "google_sheets",
        **identity,
    }
    assert "X-Evaos-Provider-Grant" not in mint_calls[0][1]
    assert mounted["url"] == "https://remote.mcp.pipedream.net/v3"
    assert {
        name: mounted["headers"][name]
        for name in (
            "Authorization",
            "x-pd-project-id",
            "x-pd-environment",
            "x-pd-external-user-id",
            "x-pd-app-slug",
            "x-pd-account-id",
        )
    } == _lease_payload(
        datetime.now(timezone.utc) + timedelta(minutes=10)
    )["headers"]
    assert isinstance(mounted["auth"], EvaosLeaseHttpAuth)
    assert mounted["trust_env"] is False


def test_identity_keyed_managed_config_remains_tolerated():
    task = MCPServerTask("pipedream-google-sheets")
    task._auth_type = "evaos_lease"
    task._validate_evaos_lease_config(
        {
            "auth": "evaos_lease",
            "app_slug": "google_sheets",
            "customer_id": "customer-fixture",
            "agent_runtime": "hermes",
            "agent_id": "agent-fixture",
            "lazy": True,
        }
    )


def test_thin_config_no_longer_fatal_blocks():
    task = MCPServerTask("pipedream-google-sheets")
    task._auth_type = "evaos_lease"
    task._validate_evaos_lease_config(
        {"auth": "evaos_lease", "app_slug": "google_sheets", "lazy": True}
    )


@pytest.mark.asyncio
async def test_lease_mint_failure_warning_is_once_and_profile_scoped(
    tmp_path, caplog
):
    source, _ = _source(tmp_path, profile_key=str(tmp_path))
    task = MCPServerTask("pipedream-google-sheets", str(tmp_path))

    async def unavailable(_url, _headers, _payload):
        return _Response(503, {})

    manager = EvaosLeaseManager(
        source=source,
        transport=unavailable,
        on_mint_failure=task._warn_evaos_lease_failure,
    )
    with caplog.at_level("WARNING", logger="tools.mcp_tool"):
        with pytest.raises(EvaosLeaseError):
            await manager.get_lease()
        with pytest.raises(EvaosLeaseError):
            await manager.get_lease()

    records = [r for r in caplog.records if "lease mint failed" in r.message]
    assert len(records) == 1
    assert "pipedream-google-sheets" in records[0].message
    assert tmp_path.name in records[0].message
    assert "apn_" not in records[0].message


@pytest.mark.parametrize(
    "override",
    [
        {"url": "https://attacker.example/mcp"},
        {"headers": {"Authorization": "static-secret"}},
        {"command": "fake-mcp"},
        {"transport": "sse"},
        {"identity_header": {"name": "X-User", "value": "override"}},
        {"ssl_verify": False},
        {"app_slug": "Google Sheets"},
    ],
)
def test_managed_lease_config_rejects_connection_and_auth_overrides(override):
    task = MCPServerTask("pipedream-google-sheets")
    task._auth_type = "evaos_lease"
    config = {
        "auth": "evaos_lease",
        "app_slug": "google_sheets",
        **override,
    }

    with pytest.raises(EvaosLeaseError, match="managed MCP"):
        task._validate_evaos_lease_config(config)


def test_schema_cache_fingerprint_includes_managed_app_identity():
    sheets = config_fingerprint(
        {
            "auth": "evaos_lease",
            "app_slug": "google_sheets",
        }
    )
    drive = config_fingerprint(
        {
            "auth": "evaos_lease",
            "app_slug": "google_drive",
        }
    )
    static = config_fingerprint(
        {
            "url": "https://remote.mcp.pipedream.net/v3",
            "app_slug": "google_sheets",
        }
    )

    assert len({sheets, drive, static}) == 3


# ---------------------------------------------------------------------------
# Direct profile-identity leases (lean path): the managed server entry carries
# the profile's own Pipedream identity (external_user_id + account_id, per the
# Pipedream developer docs), the mint body includes it, and the response echo
# is strictly validated. No grant handle anywhere.
# ---------------------------------------------------------------------------

DIRECT_EXTERNAL_USER_ID = "acct_fixture_profile_fixture"
DIRECT_ACCOUNT_ID = "apn_fixture_direct"
DIRECT_CUSTOMER_ID = "customer-fixture"
DIRECT_AGENT_ID = "grace"


def _direct_source(tmp_path, **overrides):
    broker = tmp_path / "broker"
    _write_secret(broker, "broker-secret-under-test\n")
    values = {
        "EVAOS_DESKTOP_RUNTIME_SESSION_URL": (
            "https://example.supabase.co/functions/v1/desktop-runtime-session"
        ),
        "PIPEDREAM_AGENT_BROKER_SECRET_FILE": str(broker),
    }
    kwargs = dict(
        profile_key="profile-a",
        app_slug="google_sheets",
        external_user_id=DIRECT_EXTERNAL_USER_ID,
        account_id=DIRECT_ACCOUNT_ID,
        secret_reader=values.get,
        profile_resolver=lambda: "profile-a",
        root_uid=os.getuid(),
    )
    kwargs.update(overrides)
    return EvaosLeaseSource(**kwargs)


def _direct_lease_payload(expires_at: datetime, **header_overrides):
    headers = {
        "Authorization": "Bearer lease-token-1",
        "x-pd-project-id": "proj",
        "x-pd-environment": "production",
        "x-pd-external-user-id": DIRECT_EXTERNAL_USER_ID,
        "x-pd-app-slug": "google_sheets",
        "x-pd-account-id": DIRECT_ACCOUNT_ID,
    }
    headers.update(header_overrides)
    return {
        "mcp_url": "https://remote.mcp.pipedream.net/v3",
        "headers": headers,
        "expires_at": expires_at.isoformat(),
    }


def _agent_direct_source(tmp_path, **overrides):
    values = {
        "external_user_id": None,
        "customer_id": DIRECT_CUSTOMER_ID,
        "agent_id": DIRECT_AGENT_ID,
    }
    values.update(overrides)
    return _direct_source(tmp_path, **values)


@pytest.mark.asyncio
async def test_direct_identity_is_sent_and_echo_validated(tmp_path):
    now = datetime(2026, 8, 8, tzinfo=timezone.utc)
    source = _direct_source(tmp_path)
    calls = []

    async def transport(url, headers, payload):
        calls.append((url, headers, payload))
        return _Response(200, _direct_lease_payload(now + timedelta(minutes=10)))

    manager = EvaosLeaseManager(source=source, transport=transport, now=lambda: now)
    lease = await manager.get_lease()

    assert calls[0][2] == {
        "action": "pipedream_mcp_lease",
        "app_slug": "google_sheets",
        "external_user_id": DIRECT_EXTERNAL_USER_ID,
        "account_id": DIRECT_ACCOUNT_ID,
    }
    assert "X-Evaos-Provider-Grant" not in calls[0][1]
    assert lease.headers["x-pd-external-user-id"] == DIRECT_EXTERNAL_USER_ID
    assert lease.headers["x-pd-account-id"] == DIRECT_ACCOUNT_ID


@pytest.mark.asyncio
async def test_exact_agent_account_identity_is_sent_without_grant_handle(tmp_path):
    now = datetime(2026, 8, 8, tzinfo=timezone.utc)
    source = _agent_direct_source(tmp_path)
    calls = []

    async def transport(url, headers, payload):
        calls.append((url, headers, payload))
        return _Response(200, _direct_lease_payload(now + timedelta(minutes=10)))

    manager = EvaosLeaseManager(source=source, transport=transport, now=lambda: now)
    lease = await manager.get_lease()

    assert calls[0][2] == {
        "action": "pipedream_mcp_lease",
        "app_slug": "google_sheets",
        "customer_id": DIRECT_CUSTOMER_ID,
        "agent_runtime": "hermes",
        "agent_id": DIRECT_AGENT_ID,
        "account_id": DIRECT_ACCOUNT_ID,
    }
    assert "X-Evaos-Provider-Grant" not in calls[0][1]
    assert lease.headers["x-pd-account-id"] == DIRECT_ACCOUNT_ID


@pytest.mark.parametrize(
    "overrides",
    [
        {"customer_id": None},
        {"agent_id": None},
        {"customer_id": "bad customer"},
        {"agent_id": "Bad Agent"},
    ],
)
def test_exact_agent_account_identity_requires_valid_complete_tuple(tmp_path, overrides):
    with pytest.raises(EvaosLeaseError):
        _agent_direct_source(tmp_path, **overrides)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "override",
    [
        {"x-pd-external-user-id": "someone-else"},
        {"x-pd-account-id": "apn_other_account"},
    ],
)
async def test_direct_identity_echo_mismatch_is_rejected(tmp_path, override):
    now = datetime(2026, 8, 8, tzinfo=timezone.utc)
    source = _direct_source(tmp_path)

    async def transport(url, headers, payload):
        return _Response(200, _direct_lease_payload(now + timedelta(minutes=10), **override))

    manager = EvaosLeaseManager(source=source, transport=transport, now=lambda: now)
    with pytest.raises(EvaosLeaseError):
        await manager.get_lease()


@pytest.mark.parametrize(
    "overrides",
    [
        {"account_id": None},
        {"external_user_id": None},
    ],
)
def test_identity_fields_must_come_together(tmp_path, overrides):
    with pytest.raises(EvaosLeaseError):
        _direct_source(tmp_path, **overrides)


@pytest.mark.parametrize(
    "overrides",
    [
        {"external_user_id": "bad value with spaces"},
        {"external_user_id": ""},
        {"account_id": "not-an-apn-id"},
        {"account_id": ""},
    ],
)
def test_malformed_direct_identity_is_rejected(tmp_path, overrides):
    with pytest.raises(EvaosLeaseError):
        _direct_source(tmp_path, **overrides)


@pytest.mark.asyncio
async def test_managed_config_direct_identity_reaches_the_mint_body(
    tmp_path, monkeypatch
):
    """MCPServerTask seam: a managed entry's identity flows into the exact
    mint body through _run_http, and the echoed lease mounts."""
    from tools import evaos_mcp_lease as lease_module
    from tools import mcp_tool as mcp_tool_module

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
        return _Response(
            200,
            _direct_lease_payload(
                datetime.now(timezone.utc) + timedelta(minutes=10)
            ),
        )

    monkeypatch.setattr(lease_module, "_default_transport", mint)

    mounted = {}

    class Mounted(Exception):
        pass

    class CaptureTransport:
        async def __aenter__(self):
            raise Mounted

        async def __aexit__(self, _exc_type, _exc, _tb):
            return False

    def capture_transport(url, *, http_client):
        mounted.update(
            url=url,
            headers=http_client.headers,
            auth=http_client.auth,
        )
        return CaptureTransport()

    monkeypatch.setattr(mcp_tool_module, "_MCP_HTTP_AVAILABLE", True)
    monkeypatch.setattr(mcp_tool_module, "_MCP_NEW_HTTP", True)
    monkeypatch.setattr(
        mcp_tool_module, "streamable_http_client", capture_transport
    )

    config = {
        "auth": "evaos_lease",
        "app_slug": "google_sheets",
        "lazy": True,
        "external_user_id": DIRECT_EXTERNAL_USER_ID,
        "account_id": DIRECT_ACCOUNT_ID,
    }
    task = MCPServerTask("pipedream-google-sheets", str(profile))
    task._auth_type = "evaos_lease"
    task._validate_evaos_lease_config(config)

    with pytest.raises(Mounted):
        await task._run_http(config)

    assert mint_calls[0][2] == {
        "action": "pipedream_mcp_lease",
        "app_slug": "google_sheets",
        "external_user_id": DIRECT_EXTERNAL_USER_ID,
        "account_id": DIRECT_ACCOUNT_ID,
    }
    assert "X-Evaos-Provider-Grant" not in mint_calls[0][1]
    assert mounted["url"] == "https://remote.mcp.pipedream.net/v3"
    assert mounted["headers"]["x-pd-external-user-id"] == DIRECT_EXTERNAL_USER_ID
    assert mounted["headers"]["x-pd-account-id"] == DIRECT_ACCOUNT_ID


def test_managed_config_accepts_exact_agent_account_mode():
    task = MCPServerTask("pipedream-google-sheets")
    task._auth_type = "evaos_lease"
    task._validate_evaos_lease_config(
        {
            "auth": "evaos_lease",
            "app_slug": "google_sheets",
            "lazy": True,
            "customer_id": DIRECT_CUSTOMER_ID,
            "agent_id": DIRECT_AGENT_ID,
            "account_id": DIRECT_ACCOUNT_ID,
        }
    )


def test_managed_runtime_binds_lease_identity_to_root_overlay(monkeypatch):
    from hermes_cli import managed_profile_scope, managed_scope

    authority = {
        "auth": "evaos_lease",
        "app_slug": "google_sheets",
        "lazy": True,
        "customer_id": DIRECT_CUSTOMER_ID,
        "agent_id": DIRECT_AGENT_ID,
        "account_id": DIRECT_ACCOUNT_ID,
    }
    monkeypatch.setattr(managed_profile_scope, "managed_profile_name", lambda: "main")
    monkeypatch.setattr(
        managed_scope,
        "load_managed_config",
        lambda: {"mcp_servers": {"pipedream-google-sheets": authority}},
    )

    task = MCPServerTask("pipedream-google-sheets")
    task._auth_type = "evaos_lease"
    task._validate_evaos_lease_config({**authority, "tools": {"include": ["read"]}})

    forged = {**authority, "agent_id": "sibling"}
    with pytest.raises(EvaosLeaseError, match="not root-configured"):
        task._validate_evaos_lease_config(forged)

    alternate = MCPServerTask("profile-added-server")
    alternate._auth_type = "evaos_lease"
    with pytest.raises(EvaosLeaseError, match="not root-configured"):
        alternate._validate_evaos_lease_config(authority)


def test_managed_runtime_expands_root_overlay_lease_identity(monkeypatch):
    from hermes_cli import managed_profile_scope, managed_scope

    monkeypatch.setenv("EVAOS_TEST_APP_SLUG", "google_sheets")
    monkeypatch.setenv("EVAOS_TEST_AGENT_ID", DIRECT_AGENT_ID)
    raw_authority = {
        "auth": "evaos_lease",
        "app_slug": "${EVAOS_TEST_APP_SLUG}",
        "customer_id": DIRECT_CUSTOMER_ID,
        "agent_id": "${EVAOS_TEST_AGENT_ID}",
        "account_id": DIRECT_ACCOUNT_ID,
    }
    effective_authority = {
        **raw_authority,
        "app_slug": "google_sheets",
        "agent_id": DIRECT_AGENT_ID,
    }
    monkeypatch.setattr(managed_profile_scope, "managed_profile_name", lambda: "main")
    monkeypatch.setattr(
        managed_scope,
        "load_managed_config",
        lambda: {"mcp_servers": {"pipedream-google-sheets": raw_authority}},
    )

    task = MCPServerTask("pipedream-google-sheets")
    task._auth_type = "evaos_lease"
    task._validate_evaos_lease_config(effective_authority)


def test_managed_config_rejects_mixed_profile_and_agent_identity():
    task = MCPServerTask("pipedream-google-sheets")
    task._auth_type = "evaos_lease"
    with pytest.raises(EvaosLeaseError):
        task._validate_evaos_lease_config(
            {
                "auth": "evaos_lease",
                "app_slug": "google_sheets",
                "external_user_id": DIRECT_EXTERNAL_USER_ID,
                "customer_id": DIRECT_CUSTOMER_ID,
                "agent_id": DIRECT_AGENT_ID,
                "account_id": DIRECT_ACCOUNT_ID,
            }
        )


@pytest.mark.parametrize(
    "partial",
    [
        {"external_user_id": DIRECT_EXTERNAL_USER_ID},
        {"account_id": DIRECT_ACCOUNT_ID},
    ],
    ids=["user-without-account", "account-without-user"],
)
def test_one_field_managed_identity_is_rejected(partial):
    """MCPServerTask seam: config validation enforces both-or-neither."""
    task = MCPServerTask("pipedream-google-sheets")
    task._auth_type = "evaos_lease"
    with pytest.raises(EvaosLeaseError):
        task._validate_evaos_lease_config(
            {
                "auth": "evaos_lease",
                "app_slug": "google_sheets",
                "lazy": True,
                **partial,
            }
        )


@pytest.mark.asyncio
async def test_lp2_layer0_source_contract_probe(tmp_path):
    """Secret-free source probe for the Layer-0 request/response contract."""
    now = datetime(2026, 8, 20, tzinfo=timezone.utc)
    source = _direct_source(tmp_path)
    observed = {}

    async def transport(url, headers, payload):
        observed.update(url=url, headers=headers, payload=payload)
        return _Response(
            200,
            _direct_lease_payload(now + timedelta(hours=1)),
        )

    lease = await EvaosLeaseManager(
        source=source,
        transport=transport,
        now=lambda: now,
    ).get_lease()

    assert observed["payload"] == {
        "action": "pipedream_mcp_lease",
        "app_slug": "google_sheets",
        "external_user_id": DIRECT_EXTERNAL_USER_ID,
        "account_id": DIRECT_ACCOUNT_ID,
    }
    assert set(observed["headers"]) == {
        "Content-Type",
        "X-Evaos-Desktop-Broker-Secret",
    }
    assert lease.headers["x-pd-external-user-id"] == DIRECT_EXTERNAL_USER_ID
    assert lease.headers["x-pd-account-id"] == DIRECT_ACCOUNT_ID


def test_mcp2_snake_case_tool_schema_is_written_to_cache(monkeypatch):
    from tools import mcp_schema_cache, mcp_tool_registration as registration_module
    from tools import registry as registry_module
    from tools.registry import ToolRegistry

    captured = {}
    registrations = []

    def capture_cache(_name, _fingerprint, **kwargs):
        captured.update(kwargs)

    monkeypatch.setattr(registry_module, "registry", ToolRegistry())
    monkeypatch.setattr(mcp_schema_cache, "write_cache_entry", capture_cache)
    monkeypatch.setattr(
        registration_module,
        "_track_mcp_tool_server",
        lambda tool_name, server_name, registration_home: registrations.append(
            (tool_name, server_name, registration_home)
        ),
    )
    task = MCPServerTask("lease-schema-probe")
    task._tools = [
        SimpleNamespace(
            name="read_sheet",
            description="Read a sheet",
            input_schema={"type": "object", "properties": {"id": {"type": "string"}}},
            annotations=None,
        )
    ]

    registered = registration_module._register_server_tools(
        "lease-schema-probe",
        task,
        {"auth": "evaos_lease", "app_slug": "google_sheets"},
    )

    assert registered == ["mcp__lease_schema_probe__read_sheet"]
    assert registrations == [(registered[0], task.name, task.registration_home)]
    assert captured["tools"][0]["inputSchema"] == task._tools[0].input_schema


def test_locked_mcp2_dependency_contract_matches_declared_extras():
    root = Path(__file__).resolve().parents[2]
    project = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    lock = tomllib.loads((root / "uv.lock").read_text(encoding="utf-8"))
    extras = project["project"]["optional-dependencies"]

    packages = {package["name"]: package for package in lock["package"]}
    for extra in ("dev", "mcp", "computer-use"):
        pins = {
            requirement.split("==", 1)[0]: requirement.split("==", 1)[1]
            for requirement in extras[extra]
            if "==" in requirement
        }
        for package in ("mcp", "httpx2"):
            assert package in pins
            assert packages[package]["version"] == pins[package]
