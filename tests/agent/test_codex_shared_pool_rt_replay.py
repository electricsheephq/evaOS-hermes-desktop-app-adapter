"""A stale manual Codex pool and singleton must not replay a spent refresh token."""

import base64
import json
import os
import time
from pathlib import Path

import httpx
import pytest

from agent.credential_pool import load_pool
from hermes_cli import auth, auth_codex


def _access(generation, *, expired=False, account="synthetic-account", subject="synthetic-subject"):
    claims = {
        "exp": int(time.time()) + (-3600 if expired else 3600),
        "sub": subject,
        "https://api.openai.com/auth": {"chatgpt_account_id": account},
        "generation": generation,
    }
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).rstrip(b"=").decode()
    return f"header.{payload}.signature"


class _RotatingEndpoint:
    def __init__(self):
        self.pairs = [
            {"access_token": _access(i, expired=i == 0),
             "refresh_token": f"synthetic-refresh-{i}"}
            for i in range(3)
        ]
        self.posts = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def post(self, url, *, headers=None, data=None):
        refresh = data["refresh_token"]
        replay = refresh in self.posts
        self.posts.append(refresh)
        if replay:
            return httpx.Response(400, json={"error": "refresh_token_reused"})
        generation = next(i for i, pair in enumerate(self.pairs) if pair["refresh_token"] == refresh)
        return httpx.Response(200, json=self.pairs[generation + 1])


@pytest.fixture
def shared_rotation(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    root = tmp_path / ".hermes"
    homes = [root / "profiles" / name for name in ("a", "b")]
    for home in homes:
        home.mkdir(parents=True)
        (home / "auth.json").write_text(json.dumps({"version": 1, "providers": {}}))
    shared = root / "shared-auth.json"
    endpoint = _RotatingEndpoint()
    shared.write_text(json.dumps({
        "version": 1,
        "providers": {"openai-codex": {"tokens": endpoint.pairs[0], "auth_mode": "chatgpt"}},
        "credential_pool": {"openai-codex": [{
            "id": "manual-codex", "source": "manual:device_code", "auth_type": "oauth",
            "priority": 0, "last_status": "ok", **endpoint.pairs[0],
        }]},
    }))
    if os.name != "nt":
        shared.chmod(0o660)
        os.chown(shared, -1, os.getgid())
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared))
    monkeypatch.setattr(auth_codex, "_codex_http_client", lambda **kwargs: endpoint)
    # Every reader, lock, merge and writeback is real; only the HTTP boundary is fake.
    pools = []
    for home in homes:
        monkeypatch.setenv("HERMES_HOME", str(home))
        pools.append(load_pool("openai-codex"))
        assert len(pools[-1].entries()) == 1
    monkeypatch.setenv("HERMES_HOME", str(homes[0]))
    assert pools[0].select() is not None
    assert len(endpoint.posts) == 1
    return pools, homes, shared, endpoint


@pytest.mark.parametrize("force", [False, True])
@pytest.mark.parametrize("disk_state", [
    "synced", "lagging-singleton", "undated-singleton", "expiring-pool", "expiring-undated-pool",
])
def test_stale_pool_adopts_rotation_without_replay(shared_rotation, monkeypatch, force, disk_state):
    pools, homes, shared, endpoint = shared_rotation
    expected_generation = 1
    if disk_state != "synced":
        store = json.loads(shared.read_text())
        # Isolate pool-store adoption from the successful singleton CAS.
        store["providers"]["openai-codex"].update(
            tokens=endpoint.pairs[0], last_refresh="2000-01-01T00:00:00Z")
        if "undated" in disk_state:
            store["providers"]["openai-codex"].pop("last_refresh")
        if disk_state.startswith("expiring"):
            store["credential_pool"]["openai-codex"][0]["access_token"] = _access(1, expired=True)
            expected_generation = 2
        shared.write_text(json.dumps(store))
    monkeypatch.setenv("HERMES_HOME", str(homes[1]))
    selected = (pools[1].try_refresh_matching(credential_id="manual-codex")
                if force else pools[1].select())
    assert endpoint.posts.count(endpoint.pairs[0]["refresh_token"]) == 1, "spent grant replayed"
    assert selected is not None
    assert selected.access_token == endpoint.pairs[expected_generation]["access_token"]
    assert len(endpoint.posts) == expected_generation
    store = json.loads(shared.read_text())
    assert bool(store["providers"]["openai-codex"]["tokens"].get("access_token"))
    if disk_state == "expiring-pool":
        assert store["providers"]["openai-codex"]["tokens"] == endpoint.pairs[expected_generation]
    assert all(row.get("last_status") not in {"dead", "exhausted"}
               for row in store["credential_pool"]["openai-codex"])
    assert "openai-codex" not in json.loads((homes[1] / "auth.json").read_text())["providers"]


def test_singleton_fallback_after_pool_rotation_does_not_replay(shared_rotation, monkeypatch):
    _pools, homes, shared, endpoint = shared_rotation
    monkeypatch.setenv("HERMES_HOME", str(homes[1]))
    # The pool-first ladder can bench every row and reach this singleton resolver.
    try:
        resolved = auth.resolve_codex_runtime_credentials()
    except auth.AuthError:
        pytest.fail("singleton fallback replayed a spent grant", pytrace=False)
    assert endpoint.posts.count(endpoint.pairs[0]["refresh_token"]) == 1, "spent grant replayed"
    assert resolved["api_key"] == endpoint.pairs[1]["access_token"]
    assert bool(json.loads(shared.read_text())["providers"]["openai-codex"]["tokens"].get("access_token"))


@pytest.mark.parametrize("account,subject,stamp,should_write", [
    ("synthetic-account", "synthetic-subject", "2000-01-01T00:00:00Z", True),
    ("other-account", "synthetic-subject", "2000-01-01T00:00:00Z", False),
    ("synthetic-account", "other-subject", "2000-01-01T00:00:00Z", False),
    ("synthetic-account", "synthetic-subject", "2100-01-01T00:00:00Z", False),
    ("synthetic-account", "synthetic-subject", None, False),
])
def test_manual_singleton_cas_repairs_only_older_same_principal(
    shared_rotation, account, subject, stamp, should_write,
):
    pools, _homes, shared, endpoint = shared_rotation
    entry = pools[0].entries()[0]
    store = json.loads(shared.read_text())
    singleton = store["providers"]["openai-codex"]
    old_tokens = {**endpoint.pairs[0], "access_token": _access(-1, account=account, subject=subject)}
    singleton["tokens"] = old_tokens
    if stamp is None:
        singleton.pop("last_refresh", None)
    else:
        singleton["last_refresh"] = stamp
    shared.write_text(json.dumps(store))
    with pools[0]._single_use_refresh_store_lock():
        pools[0]._sync_device_code_entry_to_auth_store(
            entry, previous_access_token=endpoint.pairs[0]["access_token"],
        )
    final_tokens = json.loads(shared.read_text())["providers"]["openai-codex"]["tokens"]
    assert final_tokens == (endpoint.pairs[1] if should_write else old_tokens)
