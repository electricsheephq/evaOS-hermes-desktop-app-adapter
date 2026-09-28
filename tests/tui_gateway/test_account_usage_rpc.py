"""``account.usage``: provider quota snapshots for the Desktop's quota cards.

Driven through ``handle_request`` so the params/result contract is enforced (strict under
``HERMES_TEST_ISOLATION``). Fetchers are fakes swapped into ``agent.account_usage._USAGE_FETCHERS``.
"""

from __future__ import annotations

import base64
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
import pytest

import tui_gateway.server as server
from agent import account_usage as au
from tui_gateway import account_usage_view as view

_SECRET = "synthetic-secret-token"
_PATH = "/synthetic/profile/auth.json"


@pytest.fixture(autouse=True)
def _clear_cache():
    view._cache.clear()
    yield
    view._cache.clear()


def _call(params: dict | None = None) -> dict:
    response = server.handle_request({"jsonrpc": "2.0", "id": 1, "method": "account.usage", "params": params or {}})
    assert "error" not in response, response
    return response["result"]


def _snap(provider: str, *windows, details=("Credits balance: $1.00",), **kw) -> au.AccountUsageSnapshot:
    return au._snapshot(provider, "usage_api", list(windows), list(details), **kw)


def _fetchers(monkeypatch, **fns) -> dict[str, int]:
    """Install fake fetchers keyed by provider id (``openai_codex`` → ``openai-codex``); returns call counts."""
    calls: dict[str, int] = {}

    def counted(name, fn):
        def fetch(base_url, api_key):
            calls[name] = calls.get(name, 0) + 1
            return fn(base_url, api_key)
        return fetch

    registry = {name.replace("_", "-"): counted(name.replace("_", "-"), fn) for name, fn in fns.items()}
    monkeypatch.setattr(au, "_USAGE_FETCHERS", registry)
    monkeypatch.setattr(view, "_codex_has_credential", lambda: True)
    monkeypatch.setattr(view, "_openrouter_credentials", lambda: ("https://openrouter.ai/api/v1", "k"))
    return calls


def _raise(exc):
    def fetch(_b, _k):
        raise exc
    return fetch


def _status_error(code: int) -> httpx.HTTPStatusError:
    request = httpx.Request("GET", f"https://usage.invalid/u?key={_SECRET}")
    return httpx.HTTPStatusError(f"boom {_SECRET}", request=request, response=httpx.Response(code, request=request))


def test_empty_params_return_snapshots_without_nous_or_credentialless_providers(monkeypatch):
    reset = datetime(2026, 10, 1, 9, 0, tzinfo=timezone.utc)
    _fetchers(
        monkeypatch,
        openai_codex=lambda b, k: _snap("openai-codex", au.AccountUsageWindow("Session", 37.0, reset), plan="Pro"),
        anthropic=lambda b, k: None,  # no credential → omitted
        nous=lambda b, k: _snap("nous"),  # usage.bars owns Nous
    )
    result = _call({})
    assert [s["provider"] for s in result["snapshots"]] == ["openai-codex"]
    snap = result["snapshots"][0]
    assert snap["plan"] == "Pro" and snap["error"] is None and snap["available"] is True
    assert snap["windows"] == [{"label": "Session", "used_percent": 37.0, "remaining_percent": 63.0,
                                "reset_at": reset.isoformat(), "detail": None}]
    assert snap["details"] == ["Credits balance: $1.00"]


@pytest.mark.parametrize(("exc", "category"), [
    (_status_error(401), "auth_expired"),
    (_status_error(429), "rate_limited"),
    (_status_error(500), "unavailable"),
    (httpx.ReadTimeout(f"slow {_SECRET}"), "timeout"),
    (RuntimeError(f"refresh failed at {_PATH} with {_SECRET}"), "unavailable"),
])
def test_fetch_failure_is_a_typed_error_snapshot_without_exception_text(monkeypatch, exc, category):
    _fetchers(monkeypatch, anthropic=_raise(exc))
    result = _call({})
    [snap] = result["snapshots"]
    assert snap["error"] == category and snap["windows"] == [] and len(snap["details"]) == 1
    assert snap["available"] is False
    wire = json.dumps(result)
    assert _SECRET not in wire and _PATH not in wire and "usage.invalid" not in wire
    assert "not found" not in wire.lower()


def test_unavailable_reason_maps_to_a_category(monkeypatch):
    _fetchers(
        monkeypatch,
        anthropic=lambda b, k: _snap("anthropic", details=(), unavailable_reason="Only for OAuth-backed accounts."),
        openrouter=lambda b, k: _snap("openrouter", details=()),  # fetched but empty
    )
    errors = {s["provider"]: s["error"] for s in _call({})["snapshots"]}
    assert errors == {"anthropic": "not_oauth", "openrouter": "unavailable"}


def test_provider_past_the_deadline_becomes_a_timeout_snapshot(monkeypatch):
    monkeypatch.setattr(view, "DEADLINE_S", 0.2)
    _fetchers(
        monkeypatch,
        openai_codex=lambda b, k: (time.sleep(2), _snap("openai-codex"))[1],
        anthropic=lambda b, k: _snap("anthropic", au.AccountUsageWindow("Current week", 10.0)),
    )
    started = time.monotonic()
    snaps = {s["provider"]: s for s in _call({})["snapshots"]}
    assert time.monotonic() - started < 1.5
    assert snaps["openai-codex"]["error"] == "timeout"
    assert snaps["anthropic"]["error"] is None


def test_serializer_clamps_percent_derives_remaining_and_drops_raw():
    snapshot = _snap("openai-codex", au.AccountUsageWindow("Session", 150.0), au.AccountUsageWindow("Weekly", -5.0),
                     au.AccountUsageWindow("Odd", float("nan")), raw={"token": _SECRET, "path": _PATH})
    wire = view.serialize_snapshot(snapshot)
    assert [(w["used_percent"], w["remaining_percent"]) for w in wire["windows"]] == [
        (100.0, 0.0), (0.0, 100.0), (None, None)]
    assert "raw" not in wire
    text = json.dumps(wire)
    assert _SECRET not in text and _PATH not in text


def test_codex_failure_without_any_credential_is_omitted(monkeypatch):
    assert view._codex_has_credential() is False  # the isolated home has no singleton and no pool
    _fetchers(monkeypatch, openai_codex=_raise(RuntimeError("No available openai-codex credential")))
    monkeypatch.setattr(view, "_codex_has_credential", lambda: False)
    assert _call({}) == {"snapshots": []}


def test_openrouter_only_on_openrouter_host(monkeypatch):
    seen = []
    _fetchers(monkeypatch, openrouter=lambda b, k: seen.append((b, k)) or _snap("openrouter"))
    monkeypatch.setattr(view, "_openrouter_credentials", lambda: None)  # custom host / no key
    assert _call({}) == {"snapshots": []} and seen == []
    view._cache.clear()
    monkeypatch.setattr(view, "_openrouter_credentials", lambda: ("https://openrouter.ai/api/v1", "k"))
    assert [s["provider"] for s in _call({})["snapshots"]] == ["openrouter"]
    assert seen == [("https://openrouter.ai/api/v1", "k")]


def test_openrouter_credentials_reject_a_non_openrouter_host(monkeypatch):
    import hermes_cli.runtime_provider as rp
    monkeypatch.setattr(rp, "resolve_runtime_provider",
                        lambda **kw: {"base_url": "https://proxy.example.invalid/v1", "api_key": "k"})
    assert view._openrouter_credentials() is None
    monkeypatch.setattr(rp, "resolve_runtime_provider",
                        lambda **kw: {"base_url": "https://openrouter.ai/api/v1", "api_key": "k"})
    assert view._openrouter_credentials() == ("https://openrouter.ai/api/v1", "k")


def test_second_call_within_ttl_uses_the_cache(monkeypatch):
    calls = _fetchers(monkeypatch, openai_codex=lambda b, k: _snap("openai-codex"),
                      anthropic=_raise(_status_error(429)))
    first = _call({})
    assert _call({}) == first
    assert calls == {"openai-codex": 1, "anthropic": 1}
    # Errors expire sooner than results.
    for key, (expiry, value) in list(view._cache.items()):
        view._cache[key] = (expiry - view.ERROR_TTL_S - 1, value)
    _call({})
    assert calls == {"openai-codex": 1, "anthropic": 2}


def test_profile_param_reads_that_profiles_home(tmp_path, monkeypatch):
    from hermes_constants import get_hermes_home
    launch, worker = tmp_path / "launch", tmp_path / "profiles" / "code"
    launch.mkdir(parents=True)
    worker.mkdir(parents=True)
    monkeypatch.setattr(server, "_hermes_home", launch)
    monkeypatch.setenv("HERMES_HOME", str(launch))
    monkeypatch.setattr(server, "_profile_home", lambda name: worker if (name or "").strip() == "code" else None)
    homes = []
    _fetchers(monkeypatch, openai_codex=lambda b, k: homes.append(str(get_hermes_home())) or _snap("openai-codex"))
    _call({})
    _call({"profile": "code"})
    assert homes == [str(launch), str(worker)]  # separate cache entries per home


def test_unknown_param_is_rejected():
    response = server.handle_request({"jsonrpc": "2.0", "id": 1, "method": "account.usage", "params": {"x": 1}})
    assert response["error"]["code"] == 4000


def test_account_usage_is_a_long_handler_and_in_the_generated_contract():
    assert "account.usage" in server._LONG_HANDLERS
    shared = Path(__file__).resolve().parents[2] / "apps" / "shared" / "src"
    assert "'account.usage': { params: ProfileParams; result: AccountUsageResult }" in (
        shared / "gateway-contract.generated.ts").read_text(encoding="utf-8")
    assert '"name": "account.usage"' in (shared / "gateway-contract.openrpc.json").read_text(encoding="utf-8")


# ── fork: managed shared-auth pool ──────────────────────────────────────────────────────────


def _jwt(exp_epoch: int) -> str:
    body = base64.urlsafe_b64encode(json.dumps({"exp": exp_epoch}).encode()).rstrip(b"=").decode("ascii")
    return f"header.{body}.signature"


def _write_managed(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2))
    if os.name != "nt":
        path.chmod(0o660)
        os.chown(path, -1, os.getgid())


def test_codex_pool_entry_only_in_the_shared_auth_file_resolves(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    profile = tmp_path / ".hermes" / "profiles" / "member"
    shared = tmp_path / ".hermes" / "shared-auth" / "auth.json"
    _write_managed(profile / "auth.json", {"version": 1, "providers": {}})
    token = _jwt(int(time.time()) + 86400)
    _write_managed(shared, {"version": 1, "providers": {}, "credential_pool": {"openai-codex": [{
        "id": "codex-shared", "source": "device_code", "auth_type": "oauth", "access_token": token,
        "refresh_token": "synthetic-refresh", "last_status": "ok", "priority": 0}]}})
    monkeypatch.setenv("HERMES_HOME", str(profile))
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared))
    monkeypatch.setattr(server, "_hermes_home", profile)

    assert view._codex_has_credential() is True
    seen = []
    monkeypatch.setattr(au, "_get_json", lambda url, headers, *, timeout: seen.append(headers["Authorization"]) or {
        "plan_type": "pro", "rate_limit": {"primary_window": {"used_percent": 40, "limit_window_seconds": 18000}}})
    monkeypatch.setattr(au, "_USAGE_FETCHERS", {"openai-codex": au._fetch_codex_account_usage})
    [snap] = _call({})["snapshots"]
    assert seen == [f"Bearer {token}"]
    assert snap["provider"] == "openai-codex" and snap["windows"][0]["used_percent"] == 40.0
    assert token not in json.dumps(snap)
