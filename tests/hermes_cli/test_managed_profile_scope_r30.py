from pathlib import Path

import pytest


@pytest.fixture
def managed_profile_env(tmp_path, monkeypatch):
    default_home = tmp_path / ".hermes"
    profile_home = default_home / "profiles" / "main"
    profile_home.mkdir(parents=True)
    shared_auth = default_home / "shared-auth" / "auth.json"
    shared_auth.parent.mkdir()
    shared_auth.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(profile_home))
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared_auth))
    return profile_home


def test_managed_profile_scope_is_bound_to_process_home(managed_profile_env):
    from hermes_cli.managed_profile_scope import (
        ManagedProfileScopeError,
        managed_profile_name,
        require_managed_profile,
    )

    assert managed_profile_name() == "main"
    assert require_managed_profile(None) == "main"
    assert require_managed_profile("current") == "main"
    assert require_managed_profile("main") == "main"
    assert require_managed_profile("all", selectors_for_current=("all",)) == "main"
    with pytest.raises(ManagedProfileScopeError, match="not authorized"):
        require_managed_profile("sibling")
    with pytest.raises(ManagedProfileScopeError, match="not authorized"):
        require_managed_profile("default")


def test_unmanaged_scope_preserves_upstream_selectors(monkeypatch):
    from hermes_cli.managed_profile_scope import require_managed_profile

    monkeypatch.delenv("HERMES_SHARED_AUTH_FILE", raising=False)
    assert require_managed_profile("sibling") == "sibling"
    assert require_managed_profile("all", selectors_for_current=("all",)) == "all"


def test_managed_default_home_fails_closed(tmp_path, monkeypatch):
    from hermes_cli.managed_profile_scope import managed_profile_name

    default_home = tmp_path / ".hermes"
    default_home.mkdir()
    shared_auth = default_home / "shared-auth" / "auth.json"
    shared_auth.parent.mkdir()
    shared_auth.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(default_home))
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared_auth))

    with pytest.raises(RuntimeError, match="not bound"):
        managed_profile_name()


def test_dashboard_and_tui_reject_sibling_profile(managed_profile_env, monkeypatch):
    from fastapi import HTTPException
    from hermes_cli import web_server
    from tui_gateway import server as tui_server

    with pytest.raises(HTTPException) as exc_info:
        web_server._resolve_profile_dir("sibling")
    assert exc_info.value.status_code == 403

    monkeypatch.setattr(tui_server, "_hermes_home", str(managed_profile_env))
    with pytest.raises(PermissionError, match="not authorized"):
        tui_server._profile_home("sibling")
    assert tui_server._profile_home("main") is None


def test_managed_gateway_rejects_reserved_default_selector(managed_profile_env):
    from fastapi import HTTPException
    from hermes_cli import web_server

    with pytest.raises(HTTPException) as exc_info:
        web_server._gateway_subcommand("default", "start")

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "profile is not authorized"


def test_unmanaged_gateway_preserves_upstream_default_selector(monkeypatch):
    from hermes_cli import web_server

    monkeypatch.delenv("HERMES_SHARED_AUTH_FILE", raising=False)
    assert web_server._gateway_subcommand("default", "start") == ["gateway", "start"]


def test_managed_dashboard_exposes_only_its_profile(
    managed_profile_env, tmp_path, monkeypatch
):
    from fastapi.testclient import TestClient
    from hermes_cli import web_server

    sibling = tmp_path / ".hermes" / "profiles" / "sibling"
    sibling.mkdir()
    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN

    listed = client.get("/api/profiles")
    assert listed.status_code == 200
    assert [row["name"] for row in listed.json()["profiles"]] == ["main"]

    active = client.get("/api/profiles/active")
    assert active.status_code == 200
    assert active.json() == {"active": "main", "current": "main"}

    sibling_soul = client.get("/api/profiles/sibling/soul")
    assert sibling_soul.status_code == 403
    assert sibling_soul.json()["detail"] == "profile is not authorized"

    create = client.post("/api/profiles", json={"name": "new-profile"})
    assert create.status_code == 403
    assert create.json()["detail"] == "profile lifecycle is managed by evaOS"
