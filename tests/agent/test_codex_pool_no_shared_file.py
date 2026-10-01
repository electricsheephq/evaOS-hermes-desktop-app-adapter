"""Classic and managed profile-local Codex pools must retain their in-memory rotation."""
import json
import os
from pathlib import Path

import pytest

from agent.credential_pool import load_pool
from hermes_cli import auth_codex
from tests.agent.test_codex_shared_pool_rt_replay import _RotatingEndpoint


@pytest.mark.parametrize(
    "source",
    [
        "device_code",
        pytest.param(
            "manual:device_code",
            marks=pytest.mark.xfail(
                strict=True,
                reason="pre-existing: with no shared file, a manual row aliasing the singleton sends the first grant twice (unchanged by this fix)",
            ),
        ),
    ],
)
def test_stale_peer_clobber_then_forced_refresh(tmp_path, monkeypatch, source):
    (tmp_path / "fakehome").mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "fakehome")
    monkeypatch.delenv("HERMES_SHARED_AUTH_FILE", raising=False)
    home = tmp_path / "custom-root"   # classic single-home install (custom root == HERMES_HOME)
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    ep = _RotatingEndpoint()
    (home / "auth.json").write_text(json.dumps({
        "version": 1,
        "providers": {"openai-codex": {"tokens": dict(ep.pairs[0]), "auth_mode": "chatgpt",
                                         "last_refresh": "2026-01-01T00:00:00Z"}},
        "credential_pool": {"openai-codex": [{
            "id": "row1", "source": source, "auth_type": "oauth", "priority": 0,
            "last_status": "ok", **ep.pairs[0]}]},
    }))
    monkeypatch.setattr(auth_codex, "_codex_http_client", lambda **kw: ep)
    a, b = load_pool("openai-codex"), load_pool("openai-codex")
    rid = a.entries()[0].id
    a.select()
    # B (stale) hits a 429 on its still-unexpired-in-its-view AT and persists its snapshot.
    b.mark_exhausted_and_rotate(status_code=429, credential_id=rid)
    row = json.loads((home / "auth.json").read_text())["credential_pool"]["openai-codex"][0]
    a.try_refresh_matching(credential_id=rid)                                    # A: forced refresh (e.g. 401)
    assert ep.posts.count(ep.pairs[0]["refresh_token"]) == 1, "A replayed the spent grant"


@pytest.mark.parametrize("managed", [False, True], ids=["classic", "managed-profile-local"])
def test_classic_independent_manual_row_stale_clobber(tmp_path, monkeypatch, managed):
    """No shared file, no singleton: an independent `hermes auth add` row, two processes."""
    (tmp_path / "fakehome").mkdir()
    monkeypatch.setattr(Path, "home", lambda: tmp_path / "fakehome")
    monkeypatch.delenv("HERMES_SHARED_AUTH_FILE", raising=False)
    home = tmp_path / "custom-root"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    ep = _RotatingEndpoint()
    (home / "auth.json").write_text(json.dumps({
        "version": 1, "providers": {},
        "credential_pool": {"openai-codex": [{
            "id": "row1", "source": "manual:device_code", "auth_type": "oauth", "priority": 0,
            "last_status": "ok", **ep.pairs[0]}]},
    }))
    monkeypatch.setattr(auth_codex, "_codex_http_client", lambda **kw: ep)
    if managed:
        shared = tmp_path / "shared-auth.json"
        shared.write_text(json.dumps({"version": 1, "providers": {}}))
        if os.name != "nt":
            shared.chmod(0o660)
            os.chown(shared, -1, os.getgid())
        monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared))
    a, b = load_pool("openai-codex"), load_pool("openai-codex")
    assert a._shared_persistence_base is None
    assert b._shared_persistence_base is None
    assert [e.source for e in a.entries()] == ["manual:device_code"]
    a.select()                                                       # A rotates RT0 -> RT1
    assert ep.posts == [ep.pairs[0]["refresh_token"]]
    b.mark_exhausted_and_rotate(status_code=401, credential_id="row1")   # stale B persists its snapshot
    a.try_refresh_matching(credential_id="row1")                     # A: forced refresh
    final = json.loads((home / "auth.json").read_text())["credential_pool"]["openai-codex"][0]
    assert ep.posts.count(ep.pairs[0]["refresh_token"]) == 1, "A replayed the spent grant"
    assert final["last_status"] == "ok"
    assert ep.posts == [pair["refresh_token"] for pair in ep.pairs[:2]]


def test_shared_mode_same_sequence_is_safe(tmp_path, monkeypatch):
    import os
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    root = tmp_path / ".hermes"
    homes = [root / "profiles" / n for n in ("a", "b")]
    for h in homes:
        h.mkdir(parents=True)
        (h / "auth.json").write_text(json.dumps({"version": 1, "providers": {}}))
    shared = root / "shared-auth.json"
    ep = _RotatingEndpoint()
    shared.write_text(json.dumps({"version": 1, "providers": {}, "credential_pool": {"openai-codex": [{
        "id": "row1", "source": "manual:device_code", "auth_type": "oauth", "priority": 0,
        "last_status": "ok", **ep.pairs[0]}]}}))
    shared.chmod(0o660)
    os.chown(shared, -1, os.getgid())
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared))
    monkeypatch.setattr(auth_codex, "_codex_http_client", lambda **kw: ep)
    pools = []
    for h in homes:
        monkeypatch.setenv("HERMES_HOME", str(h))
        pools.append(load_pool("openai-codex"))
    monkeypatch.setenv("HERMES_HOME", str(homes[0]))
    pools[0].select()
    monkeypatch.setenv("HERMES_HOME", str(homes[1]))
    pools[1].mark_exhausted_and_rotate(status_code=401, credential_id="row1")
    monkeypatch.setenv("HERMES_HOME", str(homes[0]))
    pools[0].try_refresh_matching(credential_id="row1")
    assert ep.posts.count(ep.pairs[0]["refresh_token"]) == 1
