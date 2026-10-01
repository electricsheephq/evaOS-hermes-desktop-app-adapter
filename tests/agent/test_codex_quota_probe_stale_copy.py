"""Quota probe that rotates a row must not let the caller re-adopt its stale copy (R1 round 3)."""
import json, os, time
from pathlib import Path

import pytest

from agent.credential_pool import load_pool
from hermes_cli import auth, auth_codex
from tests.agent.test_codex_shared_pool_rt_replay import _RotatingEndpoint


def _setup(tmp_path, monkeypatch, *, singleton):
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
    providers = {"openai-codex": {"tokens": ep.pairs[0], "auth_mode": "chatgpt"}} if singleton else {}
    shared.write_text(json.dumps({"version": 1, "providers": providers, "credential_pool": {"openai-codex": [{
        "id": "manual-codex", "source": "manual:device_code", "auth_type": "oauth", "priority": 0,
        "last_status": "exhausted", "last_status_at": now, "last_error_code": 429,
        "last_error_reason": "usage_limit_reached", "last_error_reset_at": now + 3600, **ep.pairs[0]}]}}))
    shared.chmod(0o660)
    os.chown(shared, -1, os.getgid())
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared))
    monkeypatch.setattr(auth_codex, "_codex_http_client", lambda **kw: ep)
    auth_codex._codex_quota_probe_cache.clear()
    return homes, shared, ep


@pytest.mark.parametrize("singleton", [True, False])
def test_probe_refresh_then_restored_keeps_rotated_pair(tmp_path, monkeypatch, singleton):
    """Single fresh pool: probe rotates RT0->RT1 and reports quota restored."""
    homes, shared, ep = _setup(tmp_path, monkeypatch, singleton=singleton)
    monkeypatch.setattr(auth, "_probe_codex_quota_restored", lambda *a, **k: True)
    monkeypatch.setenv("HERMES_HOME", str(homes[0]))
    pool = load_pool("openai-codex")
    sel = pool.select()
    row = json.loads(shared.read_text())["credential_pool"]["openai-codex"][0]
    assert ep.posts.count(ep.pairs[0]["refresh_token"]) == 1, "spent grant replayed"
    assert row["refresh_token"] != ep.pairs[0]["refresh_token"], "rotated pair overwritten by the spent one"


@pytest.mark.parametrize("singleton", [True, False])
def test_stale_pool_probe_adopts_then_restored_keeps_adopted_pair(tmp_path, monkeypatch, singleton):
    """A's probe rotates (still exhausted); stale B's probe adopts RT1 and reports restored."""
    homes, shared, ep = _setup(tmp_path, monkeypatch, singleton=singleton)
    pools = []
    for h in homes:
        monkeypatch.setenv("HERMES_HOME", str(h))
        pools.append(load_pool("openai-codex"))
    restored = {"v": False}
    monkeypatch.setattr(auth, "_probe_codex_quota_restored", lambda *a, **k: restored["v"])
    monkeypatch.setenv("HERMES_HOME", str(homes[0]))
    assert pools[0].select() is None
    restored["v"] = True
    monkeypatch.setenv("HERMES_HOME", str(homes[1]))
    sel = pools[1].select()
    row = json.loads(shared.read_text())["credential_pool"]["openai-codex"][0]
    assert ep.posts.count(ep.pairs[0]["refresh_token"]) == 1, "spent grant replayed"
    assert row["refresh_token"] != ep.pairs[0]["refresh_token"], "adopted pair overwritten by the spent one"
