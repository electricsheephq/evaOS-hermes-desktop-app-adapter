"""Managed shared-source Codex refresh and writeback regressions."""

from __future__ import annotations

import base64
import json
import multiprocessing
import os
import time
from pathlib import Path

import pytest


def _synthetic(label: str) -> str:
    """Build deterministic test-only credential sentinels without literals."""
    return f"synthetic-{label}"


def _jwt_with_exp(exp_epoch: int) -> str:
    payload = {"exp": exp_epoch}
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload).encode("utf-8")
    ).rstrip(b"=").decode("ascii")
    return f"header.{encoded}.signature"


def _write_json(path: Path, payload: dict, *, managed: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2))
    if managed and os.name != "nt":
        path.chmod(0o660)
        os.chown(path, -1, os.getgid())


def _auth_store(*, access_token: str | None, refresh_token: str | None, pool: bool = True) -> dict:
    providers = {}
    if access_token is not None or refresh_token is not None:
        providers["openai-codex"] = {
            "tokens": {
                **({"access_token": access_token} if access_token is not None else {}),
                **({"refresh_token": refresh_token} if refresh_token is not None else {}),
            },
            "last_refresh": "2026-08-30T00:00:00Z",
            "auth_mode": "chatgpt",
        }
    store = {"version": 1, "providers": providers}
    if pool:
        store["credential_pool"] = {
            "openai-codex": [{
                "id": "codex-device",
                "source": "device_code",
                "auth_type": "oauth",
                "access_token": access_token or _synthetic("pool-access"),
                "refresh_token": refresh_token or _synthetic("pool-refresh"),
                "last_status": "exhausted",
                "last_error_code": 401,
                "last_error_reason": "token_invalidated",
                "last_error_reset_at": 9999999999,
            }],
        }
    return store


@pytest.fixture()
def managed_profile_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    root = tmp_path / ".hermes"
    profile = root / "profiles" / "asuka"
    shared = root / "shared-auth" / "auth.json"
    profile.mkdir(parents=True)
    _write_json(profile / "auth.json", {"version": 1, "providers": {}})
    monkeypatch.setenv("HERMES_HOME", str(profile))
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared))
    return {"root": root, "profile": profile, "shared": shared}


def _shared_refresh_worker(
    profile_home: str,
    shared_file: str,
    calls,
    start_event,
    initial_read_barrier,
    initial_reads,
    result_queue,
) -> None:
    os.environ["HERMES_HOME"] = profile_home
    os.environ["HERMES_SHARED_AUTH_FILE"] = shared_file
    import hermes_cli.auth as auth

    def _refresh(*_args, **_kwargs):
        with calls.get_lock():
            calls.value += 1
        time.sleep(0.25)
        return {
            "access_token": _synthetic("rotated-access"),
            "refresh_token": _synthetic("rotated-refresh"),
            "last_refresh": "2026-08-30T01:00:00Z",
        }

    auth.refresh_codex_oauth_pure = _refresh
    original_read = auth._read_codex_tokens

    def _read_initial_pair(*_args, **_kwargs):
        result = original_read(*_args, **_kwargs)
        with initial_reads.get_lock():
            initial_reads.value += 1
        initial_read_barrier.wait(timeout=15)
        return result

    auth._read_codex_tokens = _read_initial_pair
    if not start_event.wait(timeout=15):
        result_queue.put(False)
        return
    try:
        resolved = auth.resolve_codex_runtime_credentials(force_refresh=True)
        result_queue.put(bool(resolved.get("api_key")))
    except Exception:
        result_queue.put(False)


def test_shared_refresh_writes_provider_and_matching_pool_without_profile_shadow(
    managed_profile_env: dict[str, Path], monkeypatch: pytest.MonkeyPatch
):
    import hermes_cli.auth as auth

    old_access, old_refresh = _synthetic("old-access"), _synthetic("old-refresh")
    new_access, new_refresh = _synthetic("new-access"), _synthetic("new-refresh")
    _write_json(managed_profile_env["shared"], _auth_store(
        access_token=old_access, refresh_token=old_refresh), managed=True)
    calls: list[tuple[str, str]] = []

    def _refresh(access_token: str, refresh_token: str, **_kwargs):
        calls.append((access_token, refresh_token))
        return {"access_token": new_access, "refresh_token": new_refresh,
                "last_refresh": "2026-08-30T01:00:00Z"}

    monkeypatch.setattr(auth, "refresh_codex_oauth_pure", _refresh)
    resolved = auth.resolve_codex_runtime_credentials(force_refresh=True)
    assert resolved["api_key"] == new_access
    assert calls == [(old_access, old_refresh)]
    shared_data = json.loads(managed_profile_env["shared"].read_text())
    provider = shared_data["providers"]["openai-codex"]
    assert provider["tokens"] == {"access_token": new_access, "refresh_token": new_refresh}
    pool_entry = shared_data["credential_pool"]["openai-codex"][0]
    assert pool_entry["access_token"] == new_access
    assert pool_entry["refresh_token"] == new_refresh
    assert pool_entry["last_status"] is None
    profile_data = json.loads((managed_profile_env["profile"] / "auth.json").read_text())
    assert "openai-codex" not in profile_data.get("providers", {})
    assert "openai-codex" not in profile_data.get("credential_pool", {})


def test_shared_cli_recovery_writes_back_to_shared_source_without_profile_shadow(
    managed_profile_env: dict[str, Path], monkeypatch: pytest.MonkeyPatch
):
    import hermes_cli.auth as auth
    old_refresh = _synthetic("recovery-old-refresh")
    recovered_access, recovered_refresh = _synthetic("recovered-access"), _synthetic("recovered-refresh")
    _write_json(managed_profile_env["shared"], _auth_store(
        access_token=None, refresh_token=old_refresh), managed=True)
    monkeypatch.setattr(auth, "_import_codex_cli_tokens", lambda: {
        "access_token": recovered_access, "refresh_token": recovered_refresh})
    resolved = auth.resolve_codex_runtime_credentials()
    assert resolved["api_key"] == recovered_access
    shared_data = json.loads(managed_profile_env["shared"].read_text())
    provider = shared_data["providers"]["openai-codex"]
    assert provider["tokens"] == {"access_token": recovered_access, "refresh_token": recovered_refresh}
    pool_entry = shared_data["credential_pool"]["openai-codex"][0]
    assert pool_entry["access_token"] == recovered_access
    assert pool_entry["refresh_token"] == recovered_refresh
    profile_data = json.loads((managed_profile_env["profile"] / "auth.json").read_text())
    assert "openai-codex" not in profile_data.get("providers", {})
    assert "openai-codex" not in profile_data.get("credential_pool", {})


def test_invalid_shared_refresh_recovers_to_shared_source_without_profile_shadow(
    managed_profile_env: dict[str, Path], monkeypatch: pytest.MonkeyPatch
):
    import hermes_cli.auth as auth
    old_access, old_refresh = _synthetic("invalid-old-access"), _synthetic("invalid-old-refresh")
    recovered_access, recovered_refresh = _synthetic("invalid-recovered-access"), _synthetic("invalid-recovered-refresh")
    _write_json(managed_profile_env["shared"], _auth_store(
        access_token=old_access, refresh_token=old_refresh), managed=True)

    def _invalid_refresh(*_args, **_kwargs):
        raise auth.AuthError("synthetic refresh rejected", provider="openai-codex",
                             code="invalid_grant", relogin_required=True)

    monkeypatch.setattr(auth, "refresh_codex_oauth_pure", _invalid_refresh)
    monkeypatch.setattr(auth, "_import_codex_cli_tokens", lambda: {
        "access_token": recovered_access, "refresh_token": recovered_refresh})
    resolved = auth.resolve_codex_runtime_credentials(force_refresh=True)
    assert resolved["api_key"] == recovered_access
    shared_data = json.loads(managed_profile_env["shared"].read_text())
    assert shared_data["providers"]["openai-codex"]["tokens"] == {
        "access_token": recovered_access, "refresh_token": recovered_refresh}
    profile_data = json.loads((managed_profile_env["profile"] / "auth.json").read_text())
    assert "openai-codex" not in profile_data.get("providers", {})


def test_shared_pool_fallback_is_used_without_creating_local_shadow(
    managed_profile_env: dict[str, Path]
):
    import hermes_cli.auth as auth
    pool_access, pool_refresh = _synthetic("pool-only-access"), _synthetic("pool-only-refresh")
    _write_json(managed_profile_env["shared"], _auth_store(
        access_token=None, refresh_token=None), managed=True)
    shared_data = json.loads(managed_profile_env["shared"].read_text())
    shared_data["credential_pool"]["openai-codex"][0].update(
        access_token=pool_access, refresh_token=pool_refresh,
        last_status=None, last_error_code=None, last_error_reason=None, last_error_reset_at=None)
    _write_json(managed_profile_env["shared"], shared_data, managed=True)
    resolved = auth.resolve_codex_runtime_credentials()
    assert resolved["api_key"] == pool_access
    assert resolved["source"] == "credential_pool"
    profile_data = json.loads((managed_profile_env["profile"] / "auth.json").read_text())
    assert "openai-codex" not in profile_data.get("providers", {})
    assert "openai-codex" not in profile_data.get("credential_pool", {})


def test_local_codex_refresh_remains_profile_local_without_managed_source(
    managed_profile_env: dict[str, Path], monkeypatch: pytest.MonkeyPatch
):
    import hermes_cli.auth as auth
    monkeypatch.delenv("HERMES_SHARED_AUTH_FILE")
    old_access, old_refresh = _synthetic("local-old-access"), _synthetic("local-old-refresh")
    new_access, new_refresh = _synthetic("local-new-access"), _synthetic("local-new-refresh")
    _write_json(managed_profile_env["profile"] / "auth.json", _auth_store(
        access_token=old_access, refresh_token=old_refresh))
    monkeypatch.setattr(auth, "refresh_codex_oauth_pure", lambda *_args, **_kwargs: {
        "access_token": new_access, "refresh_token": new_refresh})
    resolved = auth.resolve_codex_runtime_credentials(force_refresh=True)
    assert resolved["api_key"] == new_access
    local_data = json.loads((managed_profile_env["profile"] / "auth.json").read_text())
    assert local_data["providers"]["openai-codex"]["tokens"] == {
        "access_token": new_access, "refresh_token": new_refresh}


def test_force_refresh_ignores_unrelated_future_last_refresh(
    managed_profile_env: dict[str, Path], monkeypatch: pytest.MonkeyPatch
):
    import hermes_cli.auth as auth
    old_access, old_refresh = _synthetic("future-old-access"), _synthetic("future-old-refresh")
    new_access, new_refresh = _synthetic("future-new-access"), _synthetic("future-new-refresh")
    store = _auth_store(access_token=old_access, refresh_token=old_refresh)
    store["providers"]["openai-codex"]["last_refresh"] = "2099-08-30T00:00:00Z"
    _write_json(managed_profile_env["shared"], store, managed=True)
    calls: list[int] = []
    def _refresh(*_args, **_kwargs):
        calls.append(1)
        return {"access_token": new_access, "refresh_token": new_refresh}
    monkeypatch.setattr(auth, "refresh_codex_oauth_pure", _refresh)
    resolved = auth.resolve_codex_runtime_credentials(force_refresh=True)
    assert resolved["api_key"] == new_access
    assert calls == [1]


def test_shared_refresh_is_serialized_and_second_profile_adopts_rotated_pair(
    managed_profile_env: dict[str, Path]
):
    old_access = _jwt_with_exp(int(time.time()) - 1)
    old_refresh = _synthetic("concurrent-old-refresh")
    _write_json(managed_profile_env["shared"], _auth_store(
        access_token=old_access, refresh_token=old_refresh), managed=True)
    reviewer = managed_profile_env["root"] / "profiles" / "reviewer"
    reviewer.mkdir(parents=True)
    _write_json(reviewer / "auth.json", {"version": 1, "providers": {}})
    context = multiprocessing.get_context("spawn")
    calls = context.Value("i", 0)
    initial_reads = context.Value("i", 0)
    initial_read_barrier = context.Barrier(2)
    start_event = context.Event()
    result_queue = context.Queue()
    processes = [context.Process(target=_shared_refresh_worker, args=(
        str(profile), str(managed_profile_env["shared"]), calls, start_event,
        initial_read_barrier, initial_reads, result_queue))
        for profile in (managed_profile_env["profile"], reviewer)]
    for process in processes:
        process.start()
    start_event.set()
    assert [result_queue.get(timeout=15) for _ in processes] == [True, True]
    assert initial_reads.value == 2
    for process in processes:
        process.join(timeout=15)
        assert process.exitcode == 0
    assert calls.value == 1
    shared_data = json.loads(managed_profile_env["shared"].read_text())
    pool_entry = shared_data["credential_pool"]["openai-codex"][0]
    assert pool_entry["access_token"] == _synthetic("rotated-access")
    assert pool_entry["refresh_token"] == _synthetic("rotated-refresh")
    for profile in (managed_profile_env["profile"], reviewer):
        profile_data = json.loads((profile / "auth.json").read_text())
        assert "openai-codex" not in profile_data.get("providers", {})
        assert "openai-codex" not in profile_data.get("credential_pool", {})
