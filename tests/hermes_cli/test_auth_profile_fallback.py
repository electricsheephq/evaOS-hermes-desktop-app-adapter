"""Tests for cross-profile auth fallback.

When ``HERMES_HOME`` points to a named profile, ``read_credential_pool()``
and ``get_provider_auth_state()`` fall back to the global-root
``auth.json`` per-provider when the profile has no entries for that
provider.  Writes still target the profile only.

See the #18594 follow-up report: profile workers couldn't see providers
authenticated only at the global root.
"""

from __future__ import annotations

import json
import multiprocessing
import os
import stat
import time
from contextlib import contextmanager
from pathlib import Path

import pytest


def _mark_shared_credential_in_process(
    profile_home: str,
    shared_file: str,
    credential_id: str,
    ready_queue,
    start_event,
) -> None:
    os.environ["HERMES_HOME"] = profile_home
    os.environ["HERMES_SHARED_AUTH_FILE"] = shared_file
    from agent.credential_pool import load_pool

    pool = load_pool("openrouter")
    ready_queue.put(credential_id)
    if not start_event.wait(timeout=10):
        raise RuntimeError("shared-auth concurrency start timed out")
    pool.mark_exhausted_and_rotate(status_code=429, credential_id=credential_id)


def _make_auth_store(pool: dict | None = None, providers: dict | None = None) -> dict:
    store: dict = {"version": 1}
    if pool is not None:
        store["credential_pool"] = pool
    if providers is not None:
        store["providers"] = providers
    return store


@pytest.fixture()
def profile_env(tmp_path, monkeypatch):
    """Set up a global root + an active profile under Path.home()/.hermes/profiles/coder.

    * Path.home() -> tmp_path
    * Global root -> tmp_path/.hermes            (has its own auth.json fixture)
    * Profile     -> tmp_path/.hermes/profiles/coder   (active, HERMES_HOME points here)

    This mirrors the real "named profile mounted under the default root"
    layout that profile users actually have on disk.
    """
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    global_root = tmp_path / ".hermes"
    global_root.mkdir()
    profile_dir = global_root / "profiles" / "coder"
    profile_dir.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(profile_dir))
    return {"global": global_root, "profile": profile_dir}


def _write(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2))
    if "shared-auth" in path.parts and os.name != "nt":
        path.chmod(0o660)
        os.chown(path, -1, os.getgid())


# ---------------------------------------------------------------------------
# read_credential_pool — provider-slice reads
# ---------------------------------------------------------------------------








def test_missing_global_auth_file_is_safe(profile_env):
    """Profile processes that never had a global auth.json still work."""
    from hermes_cli.auth import read_credential_pool

    # No global auth.json written at all.
    _write(profile_env["profile"] / "auth.json", _make_auth_store(pool={
        "openrouter": [{
            "id": "prof-1",
            "label": "profile",
            "auth_type": "api_key",
            "priority": 0,
            "source": "manual",
            "access_token": "sk-profile",
        }],
    }))

    assert read_credential_pool("openrouter")[0]["id"] == "prof-1"
    assert read_credential_pool("anthropic") == []


def test_malformed_global_auth_file_does_not_break_profile_read(profile_env):
    (profile_env["global"] / "auth.json").write_text("{not valid json")
    _write(profile_env["profile"] / "auth.json", _make_auth_store(pool={
        "openrouter": [{
            "id": "prof-1",
            "label": "profile",
            "auth_type": "api_key",
            "priority": 0,
            "source": "manual",
            "access_token": "sk-profile",
        }],
    }))

    from hermes_cli.auth import read_credential_pool

    # Profile reads still work; malformed global is silently ignored.
    assert read_credential_pool("openrouter")[0]["id"] == "prof-1"
    # And no fallback for anthropic since global is unreadable.
    assert read_credential_pool("anthropic") == []


# ---------------------------------------------------------------------------
# read_credential_pool — whole-pool reads (provider_id=None)
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# get_provider_auth_state — singleton fallback
# ---------------------------------------------------------------------------


def test_provider_auth_state_falls_back_to_global_when_profile_has_none(profile_env):
    from hermes_cli.auth import get_provider_auth_state

    _write(profile_env["global"] / "auth.json", _make_auth_store(providers={
        "nous": {"access_token": "nous-global", "refresh_token": "rt-global"},
    }))
    _write(profile_env["profile"] / "auth.json", _make_auth_store(providers={}))

    state = get_provider_auth_state("nous")
    assert state is not None
    assert state["access_token"] == "nous-global"


def test_provider_auth_state_returns_none_when_neither_has_it(profile_env):
    from hermes_cli.auth import get_provider_auth_state

    _write(profile_env["global"] / "auth.json", _make_auth_store(providers={}))
    _write(profile_env["profile"] / "auth.json", _make_auth_store(providers={}))

    assert get_provider_auth_state("nous") is None


# ---------------------------------------------------------------------------
# _load_provider_state — internal global fallback (issue #18594 follow-up)
#
# Several runtime helpers (notably ``resolve_nous_runtime_credentials`` and
# ``resolve_nous_access_token``) call ``_load_provider_state`` directly with
# a profile-loaded auth store rather than going through
# ``get_provider_auth_state``. Without the fallback wired into
# ``_load_provider_state`` itself, those helpers raise ``"Hermes is not
# logged into Nous Portal"`` even though the user has a valid global Nous
# login. These tests pin the per-provider shadowing into the helper.
# ---------------------------------------------------------------------------






# ---------------------------------------------------------------------------
# Classic mode — no fallback path should ever trigger
# ---------------------------------------------------------------------------




# ---------------------------------------------------------------------------
# Writes stay scoped to the profile
# ---------------------------------------------------------------------------


def test_write_credential_pool_targets_profile_not_global(profile_env):
    from hermes_cli.auth import read_credential_pool, write_credential_pool

    _write(profile_env["global"] / "auth.json", _make_auth_store(pool={
        "openrouter": [{
            "id": "glob-1",
            "label": "global",
            "auth_type": "api_key",
            "priority": 0,
            "source": "manual",
            "access_token": "sk-global",
        }],
    }))

    write_credential_pool("openrouter", [{
        "id": "prof-new",
        "label": "profile-new",
        "auth_type": "api_key",
        "priority": 0,
        "source": "manual",
        "access_token": "sk-profile-new",
    }])

    # Global auth.json unchanged.
    global_data = json.loads((profile_env["global"] / "auth.json").read_text())
    assert global_data["credential_pool"]["openrouter"][0]["id"] == "glob-1"

    # Profile auth.json holds the new entry.
    profile_data = json.loads((profile_env["profile"] / "auth.json").read_text())
    assert profile_data["credential_pool"]["openrouter"][0]["id"] == "prof-new"

    # Subsequent read returns profile (shadows global).
    assert [e["id"] for e in read_credential_pool("openrouter")] == ["prof-new"]




def test_auth_lock_reentrancy_is_scoped_after_profile_context_switch(profile_env):
    """Changing profile context cannot inherit another store's lock depth."""
    import hermes_cli.auth as auth
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    profile_b = profile_env["global"] / "profiles" / "reviewer"
    profile_b.mkdir(parents=True)
    profile_b_lock = profile_b / "auth.lock"

    with auth._auth_store_lock():
        holder_a = auth._auth_lock_holder_for(profile_env["profile"] / "auth.json")
        assert getattr(holder_a, "depth", 0) == 1

        token = set_hermes_home_override(profile_b)
        try:
            holder_b = auth._auth_lock_holder_for(profile_b / "auth.json")
            assert holder_b is not holder_a
            assert getattr(holder_b, "depth", 0) == 0
            assert not profile_b_lock.exists()

            with auth._auth_store_lock():
                assert profile_b_lock.exists()
                assert getattr(holder_b, "depth", 0) == 1
        finally:
            reset_hermes_home_override(token)

    assert getattr(holder_a, "depth", 0) == 0


# ---------------------------------------------------------------------------
# write_credential_pool — stale-snapshot cooldown merge
# ---------------------------------------------------------------------------


@pytest.fixture()
def classic_env(tmp_path, monkeypatch):
    """Classic single-root layout (HERMES_HOME != ~/.hermes, no profiles)."""
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: fake_home)
    hermes_home = tmp_path / "classic"
    hermes_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    return hermes_home


def _pool_entry(**overrides) -> dict:
    entry = {
        "id": "cred-x",
        "label": "key-x",
        "auth_type": "api_key",
        "priority": 0,
        "source": "manual",
        "access_token": "sk-x",
    }
    entry.update(overrides)
    return entry




def test_write_pool_never_merges_cooldown_onto_reauthed_entry(classic_env):
    """A token change means re-auth: the old cooldown must never carry over.

    A fresh login intentionally clears the entry's status; resurrecting the
    stale cooldown onto the new credentials would bench a just-authorized key.
    """
    from hermes_cli.auth import write_credential_pool

    _write(classic_env / "auth.json", _make_auth_store(pool={
        "openrouter": [_pool_entry(
            access_token="sk-old",
            last_status="exhausted",
            last_status_at=time.time() - 60,  # newer AND unexpired
            last_error_code=429,
        )],
    }))

    # Same entry id, freshly re-authed with a new token and cleared status.
    write_credential_pool("openrouter", [_pool_entry(access_token="sk-new")])

    data = json.loads((classic_env / "auth.json").read_text())
    persisted = data["credential_pool"]["openrouter"][0]
    assert persisted["access_token"] == "sk-new"
    assert persisted.get("last_status") != "exhausted"
    assert persisted.get("last_error_code") is None


def test_managed_shared_pool_persists_status_to_shared_source(profile_env, monkeypatch):
    from agent.credential_pool import load_pool

    shared = profile_env["global"] / "shared-auth" / "auth.json"
    shared.parent.mkdir()
    _write(shared, _make_auth_store(pool={"openrouter": [_pool_entry(id="shared-1")]}))
    _write(profile_env["profile"] / "auth.json", _make_auth_store(pool={}))
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared))
    load_pool("openrouter").mark_exhausted_and_rotate(status_code=429, credential_id="shared-1")
    persisted = json.loads(shared.read_text())["credential_pool"]["openrouter"][0]
    assert persisted["last_status"] == "exhausted"
    assert persisted["last_error_code"] == 429
    assert not json.loads((profile_env["profile"] / "auth.json").read_text()).get("credential_pool", {}).get("openrouter")


def test_managed_shared_pool_adds_manual_credential_to_profile_shadow(profile_env, monkeypatch):
    from agent.credential_pool import PooledCredential, load_pool

    shared = profile_env["global"] / "shared-auth" / "auth.json"
    shared.parent.mkdir()
    _write(shared, _make_auth_store(pool={"openrouter": [_pool_entry(id="shared-1", access_token="shared-synthetic")]}))
    profile_auth = profile_env["profile"] / "auth.json"
    _write(profile_auth, _make_auth_store(pool={}))
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared))
    before = shared.read_bytes()
    pool = load_pool("openrouter")
    added = pool.add_entry(PooledCredential.from_dict("openrouter", _pool_entry(id="profile-manual", access_token="profile-synthetic")))
    assert added.id == "profile-manual"
    assert shared.read_bytes() == before
    assert [e["id"] for e in json.loads(profile_auth.read_text())["credential_pool"]["openrouter"]] == ["profile-manual"]


def test_managed_profile_source_creates_local_shadow_without_mutating_shared(profile_env, monkeypatch):
    from agent import credential_pool

    shared = profile_env["global"] / "shared-auth" / "auth.json"
    shared.parent.mkdir()
    _write(shared, _make_auth_store(pool={"openrouter": [_pool_entry(id="shared-1", access_token="shared-synthetic")]}))
    profile_auth = profile_env["profile"] / "auth.json"
    _write(profile_auth, _make_auth_store(pool={}))
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared))
    monkeypatch.setattr(credential_pool, "get_env_prefer_dotenv", lambda key: "profile-synthetic" if key == "OPENROUTER_API_KEY" else "")
    before = shared.read_bytes()
    pool = credential_pool.load_pool("openrouter")
    assert pool.select().source == "env:OPENROUTER_API_KEY"
    assert shared.read_bytes() == before
    assert json.loads(profile_auth.read_text())["credential_pool"]["openrouter"][0]["source"] == "env:OPENROUTER_API_KEY"


def test_managed_shared_singleton_is_not_copied_into_profile_pool(profile_env, monkeypatch):
    from agent import credential_pool

    shared = profile_env["global"] / "shared-auth" / "auth.json"
    shared.parent.mkdir()
    _write(shared, _make_auth_store(
        pool={"nous": [_pool_entry(id="shared-nous", access_token="shared-pool-synthetic", auth_type="oauth")]},
        providers={"nous": {"access_token": "shared-singleton-synthetic", "refresh_token": "shared-refresh-synthetic"}},
    ))
    profile_auth = profile_env["profile"] / "auth.json"
    _write(profile_auth, _make_auth_store(pool={}))
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared))
    monkeypatch.setattr(credential_pool, "get_env_prefer_dotenv", lambda _key: "")
    pool = credential_pool.load_pool("nous")
    assert [entry.id for entry in pool.entries()] == ["shared-nous"]
    assert not json.loads(profile_auth.read_text()).get("credential_pool", {}).get("nous")


def test_managed_shared_auth_rejects_world_permissions(profile_env, monkeypatch):
    from hermes_cli.auth import read_credential_pool
    if os.name == "nt":
        pytest.skip("POSIX mode validation")
    shared = profile_env["global"] / "shared-auth" / "auth.json"
    shared.parent.mkdir()
    _write(shared, _make_auth_store(pool={"openrouter": [_pool_entry()]}))
    shared.chmod(0o664)
    _write(profile_env["profile"] / "auth.json", _make_auth_store(pool={}))
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared))
    with pytest.raises(RuntimeError, match="unsafe metadata"):
        read_credential_pool("openrouter")


def test_managed_shared_auth_rejects_unapproved_owner(profile_env, monkeypatch):
    from hermes_cli import auth as auth_mod

    if os.name == "nt":
        pytest.skip("POSIX owner validation")
    shared = profile_env["global"] / "shared-auth" / "auth.json"
    shared.parent.mkdir()
    _write(shared, _make_auth_store(pool={"openrouter": [_pool_entry()]}))
    _write(profile_env["profile"] / "auth.json", _make_auth_store(pool={}))
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared))
    monkeypatch.setattr(
        auth_mod,
        "_managed_shared_auth_owner_is_authorized",
        lambda owner_uid, gid: False,
    )

    with pytest.raises(RuntimeError, match="unsafe metadata"):
        auth_mod.read_credential_pool("openrouter")


def test_managed_shared_pool_does_not_override_local_provider(profile_env, monkeypatch):
    from hermes_cli.auth import read_credential_pool_with_source
    shared = profile_env["global"] / "shared-auth" / "auth.json"
    shared.parent.mkdir()
    _write(shared, _make_auth_store(pool={"openrouter": [_pool_entry(id="shared-1", access_token="shared")] }))
    profile_auth = profile_env["profile"] / "auth.json"
    _write(profile_auth, _make_auth_store(pool={"openrouter": [_pool_entry(id="local-1", access_token="local")] }))
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared))
    entries, source_path = read_credential_pool_with_source("openrouter")
    assert [entry["id"] for entry in entries] == ["local-1"]
    assert source_path == profile_auth


def test_managed_shared_pool_preserves_concurrent_process_updates(
    profile_env, monkeypatch
):
    shared = profile_env["global"] / "shared-auth" / "auth.json"
    shared.parent.mkdir()
    _write(shared, _make_auth_store(pool={
        "openrouter": [
            _pool_entry(id="shared-a", access_token="token-a", priority=0),
            _pool_entry(id="shared-b", access_token="token-b", priority=1),
        ],
    }))
    profile_b = profile_env["global"] / "profiles" / "reviewer"
    profile_b.mkdir(parents=True)
    _write(profile_env["profile"] / "auth.json", _make_auth_store(pool={}))
    _write(profile_b / "auth.json", _make_auth_store(pool={}))
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared))

    context = multiprocessing.get_context("spawn")
    ready_queue = context.Queue()
    start_event = context.Event()
    processes = [
        context.Process(
            target=_mark_shared_credential_in_process,
            args=(
                str(profile_home),
                str(shared),
                credential_id,
                ready_queue,
                start_event,
            ),
        )
        for profile_home, credential_id in (
            (profile_env["profile"], "shared-a"),
            (profile_b, "shared-b"),
        )
    ]
    for process in processes:
        process.start()
    assert {ready_queue.get(timeout=10) for _ in processes} == {
        "shared-a",
        "shared-b",
    }
    start_event.set()
    for process in processes:
        process.join(timeout=15)
        assert process.exitcode == 0

    persisted = json.loads(shared.read_text())["credential_pool"]["openrouter"]
    assert {entry["id"] for entry in persisted} == {"shared-a", "shared-b"}
    assert {entry.get("last_status") for entry in persisted} == {"exhausted"}
    if os.name != "nt":
        assert stat.S_IMODE(shared.stat().st_mode) == 0o660
        assert stat.S_IMODE(shared.with_suffix(".lock").stat().st_mode) == 0o660
        assert shared.stat().st_gid == shared.with_suffix(".lock").stat().st_gid


def test_managed_profile_cannot_remove_shared_pool_or_resurrect_root_removal(
    profile_env, monkeypatch
):
    from agent.credential_pool import load_pool
    from hermes_cli.auth import write_credential_pool

    shared = profile_env["global"] / "shared-auth" / "auth.json"
    shared.parent.mkdir()
    initial = [
        _pool_entry(id="shared-a", access_token="token-a", priority=0),
        _pool_entry(id="shared-b", access_token="token-b", priority=1),
    ]
    _write(shared, _make_auth_store(pool={"openrouter": initial}))
    _write(profile_env["profile"] / "auth.json", _make_auth_store(pool={}))
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared))

    removing_pool = load_pool("openrouter")
    stale_pool = load_pool("openrouter")
    with pytest.raises(
        PermissionError,
        match="managed shared credentials cannot be removed from a profile",
    ):
        removing_pool.remove_index(1)
    assert {
        entry["id"]
        for entry in json.loads(shared.read_text())["credential_pool"]["openrouter"]
    } == {"shared-a", "shared-b"}

    # A root-owned action removes A and rotates B after both pools loaded. The
    # stale status update must preserve this token and must not recreate A.
    write_credential_pool(
        "openrouter",
        [_pool_entry(id="shared-b", access_token="token-b-rotated", priority=0)],
        removed_ids=["shared-a"],
        target_path=shared,
    )
    stale_pool.mark_exhausted_and_rotate(
        status_code=429,
        credential_id="shared-b",
    )

    persisted = json.loads(shared.read_text())["credential_pool"]["openrouter"]
    assert [entry["id"] for entry in persisted] == ["shared-b"]
    assert persisted[0]["access_token"] == "token-b-rotated"
    assert persisted[0]["last_status"] == "exhausted"
    assert [entry.id for entry in stale_pool.entries()] == ["shared-b"]


def test_managed_shared_pool_sanitizes_disk_only_borrowed_secrets(profile_env, monkeypatch):
    from hermes_cli.auth import write_credential_pool
    shared = profile_env["global"] / "shared-auth" / "auth.json"
    shared.parent.mkdir()
    raw = _pool_entry(id="shared-a", source="bitwarden", access_token="borrowed-token", client_secret="borrowed-client-secret")
    _write(shared, _make_auth_store(pool={"openrouter": [raw]}))
    _write(profile_env["profile"] / "auth.json", _make_auth_store(pool={}))
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared))
    write_credential_pool("openrouter", [{**raw, "last_status": "exhausted"}], base_entries=[dict(raw)], target_path=shared)
    persisted = json.loads(shared.read_text())["credential_pool"]["openrouter"][0]
    assert persisted["last_status"] == "exhausted"
    assert "access_token" not in persisted and "client_secret" not in persisted
    assert persisted["secret_fingerprint"].startswith("sha256:")


def test_managed_shared_auth_corruption_fails_closed(profile_env, monkeypatch):
    from hermes_cli.auth import read_credential_pool
    shared = profile_env["global"] / "shared-auth" / "auth.json"
    shared.parent.mkdir()
    shared.write_text("{broken", encoding="utf-8")
    if os.name != "nt":
        shared.chmod(0o660)
        os.chown(shared, -1, os.getgid())
    _write(profile_env["profile"] / "auth.json", _make_auth_store(pool={}))
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared))
    with pytest.raises(RuntimeError, match="managed auth store is corrupt"):
        read_credential_pool("openrouter")
    assert shared.with_suffix(".json.corrupt").is_file()


def test_managed_shared_auth_missing_file_fails_closed(profile_env, monkeypatch):
    from hermes_cli.auth import read_credential_pool
    _write(profile_env["profile"] / "auth.json", _make_auth_store(pool={}))
    shared = profile_env["global"] / "shared-auth" / "auth.json"
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared))
    with pytest.raises(RuntimeError, match="shared auth file is unavailable"):
        read_credential_pool("openrouter")


def test_managed_shared_auth_rejects_symlink(profile_env, monkeypatch):
    from hermes_cli.auth import read_credential_pool
    real_shared = profile_env["global"] / "real-auth.json"
    _write(real_shared, _make_auth_store(pool={}))
    shared_link = profile_env["global"] / "shared-auth.json"
    shared_link.symlink_to(real_shared)
    _write(profile_env["profile"] / "auth.json", _make_auth_store(pool={}))
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared_link))
    with pytest.raises(RuntimeError, match="regular no-follow"):
        read_credential_pool("openrouter")
