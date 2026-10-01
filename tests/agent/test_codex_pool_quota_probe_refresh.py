"""Quota-probe rotations must serialize and keep the singleton fallback on the current grant."""
from contextlib import contextmanager
import json
import os
import time
from pathlib import Path

import pytest

from agent.credential_pool import load_pool
from hermes_cli import auth, auth_codex
from tests.agent.test_codex_shared_pool_rt_replay import _RotatingEndpoint


@pytest.fixture
def benched(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    root = tmp_path / ".hermes"
    homes = [root / "profiles" / n for n in ("a", "b")]
    for h in homes:
        h.mkdir(parents=True)
        (h / "auth.json").write_text(json.dumps({"version": 1, "providers": {}}))
    shared = root / "shared-auth.json"
    ep = _RotatingEndpoint()
    now = time.time()
    shared.write_text(json.dumps({
        "version": 1,
        "providers": {"openai-codex": {"tokens": ep.pairs[0], "auth_mode": "chatgpt"}},
        "credential_pool": {"openai-codex": [{
            "id": "manual-codex", "source": "manual:device_code", "auth_type": "oauth",
            "priority": 0, "last_status": "exhausted", "last_status_at": now,
            "last_error_code": 429, "last_error_reason": "usage_limit_reached",
            "last_error_reset_at": now + 3600, **ep.pairs[0]}]},
    }))
    if os.name != "nt":
        shared.chmod(0o660)
        os.chown(shared, -1, os.getgid())
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared))
    monkeypatch.setattr(auth_codex, "_codex_http_client", lambda **kw: ep)
    # Quota still exhausted upstream (usage endpoint is not part of the fake).
    monkeypatch.setattr(auth, "_probe_codex_quota_restored", lambda *a, **k: False)
    auth_codex._codex_quota_probe_cache.clear()
    return homes, shared, ep


def test_probe_rotation_then_route5_fallback(benched, monkeypatch):
    homes, shared, ep = benched
    monkeypatch.setenv("HERMES_HOME", str(homes[0]))
    assert load_pool("openai-codex").select() is None      # benched; probe rotated RT0 -> RT1
    assert ep.posts == [ep.pairs[0]["refresh_token"]]
    store = json.loads(shared.read_text())
    try:
        auth.resolve_codex_runtime_credentials()            # ladder rung after an empty pool
    except auth.AuthError:
        pass
    assert ep.posts.count(ep.pairs[0]["refresh_token"]) == 1, "route 5 replayed the probe-spent grant"


def test_stale_benched_pool_probe_replays(benched, monkeypatch):
    homes, shared, ep = benched
    pools = []
    for h in homes:
        monkeypatch.setenv("HERMES_HOME", str(h))
        pools.append(load_pool("openai-codex"))
    monkeypatch.setenv("HERMES_HOME", str(homes[0]))
    assert pools[0].select() is None                        # A's probe rotates RT0 -> RT1
    monkeypatch.setenv("HERMES_HOME", str(homes[1]))
    pools[1].select()                                       # B (loaded before) probes with memory pair
    assert ep.posts.count(ep.pairs[0]["refresh_token"]) == 1, "stale pool probe replayed spent grant"


def test_probe_refresh_lock_excludes_usage_http(benched, monkeypatch):
    homes, _shared, endpoint = benched
    monkeypatch.setenv("HERMES_HOME", str(homes[0]))
    pool = load_pool("openai-codex")
    original_lock = pool._single_use_refresh_store_lock
    original_refresh = auth._refresh_expired_codex_probe_token
    held = False
    events = []

    @contextmanager
    def observed_lock():
        nonlocal held
        with original_lock():
            held = True
            events.append("locked")
            try:
                yield
            finally:
                held = False
                events.append("unlocked")

    def observed_refresh(*args, **kwargs):
        assert held, "quota pre-refresh ran outside the source lock"
        events.append("refresh")
        return original_refresh(*args, **kwargs)

    def observed_usage(*args, **kwargs):
        assert not held, "usage HTTP ran inside the refresh lock"
        events.append("usage")
        return False

    monkeypatch.setattr(pool, "_single_use_refresh_store_lock", observed_lock)
    monkeypatch.setattr(auth, "_refresh_expired_codex_probe_token", observed_refresh)
    monkeypatch.setattr(auth, "_probe_codex_quota_restored", observed_usage)
    assert pool.select() is None
    assert events == ["locked", "refresh", "unlocked", "usage"]
    assert len(endpoint.posts) == 1
