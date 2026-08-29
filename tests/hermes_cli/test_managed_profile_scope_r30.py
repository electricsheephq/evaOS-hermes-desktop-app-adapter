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


def test_managed_current_hub_selector_validates_process_home(
    managed_profile_env, tmp_path, monkeypatch
):
    from fastapi import HTTPException
    from hermes_cli import web_server

    assert web_server._profile_cli_args(None) == []
    assert web_server._profile_cli_args("current") == []

    monkeypatch.setenv("HERMES_HOME", str(tmp_path / ".hermes"))
    for selector in (None, "current"):
        with pytest.raises(HTTPException) as exc_info:
            web_server._profile_cli_args(selector)
        assert exc_info.value.status_code == 503
        assert exc_info.value.detail == "managed gateway is not bound to a named profile"


def test_managed_current_export_uses_process_profile(
    managed_profile_env, tmp_path, monkeypatch
):
    from fastapi.testclient import TestClient
    from hermes_cli import profiles, web_server

    output = tmp_path / "main-export.tar.gz"
    calls = []

    def fake_export(name, destination, *, extra_files=None):
        calls.append((name, destination, extra_files))
        return output

    monkeypatch.setattr(profiles, "export_profile", fake_export)
    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN

    response = client.post(
        "/api/profiles/current/export",
        json={"output": str(output)},
    )

    assert response.status_code == 200
    assert response.json() == {"ok": True, "archive": str(output)}
    assert calls == [("main", str(output), None)]


def test_managed_current_profile_actions_use_canonical_process_name(
    managed_profile_env, monkeypatch
):
    from fastapi.testclient import TestClient
    from hermes_cli import profile_describer, web_server

    calls = []

    def fake_describe(name, *, overwrite=False):
        calls.append((name, overwrite))
        return profile_describer.DescribeOutcome(
            profile_name=name,
            ok=True,
            description="synthetic description",
        )

    monkeypatch.setattr(profile_describer, "describe_profile", fake_describe)
    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN

    setup = client.get("/api/profiles/current/setup-command")
    assert setup.status_code == 200
    assert setup.json() == {"command": "main setup"}

    described = client.post(
        "/api/profiles/current/describe-auto",
        json={"overwrite": True},
    )
    assert described.status_code == 200
    assert calls == [("main", True)]


def test_managed_named_process_skips_default_multiplex_scope(
    managed_profile_env, monkeypatch
):
    from gateway.config import PORT_BINDING_PLATFORM_VALUES
    from hermes_cli import web_server

    monkeypatch.setattr(
        web_server,
        "_config_profile_scope",
        lambda _profile: (_ for _ in ()).throw(
            AssertionError("managed process entered default multiplex scope")
        ),
    )

    platform_id = sorted(PORT_BINDING_PLATFORM_VALUES)[0]
    assert web_server._multiplex_port_binding_conflict(platform_id, "current") is None


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
    from hermes_cli import profiles, web_server

    sibling = tmp_path / ".hermes" / "profiles" / "sibling"
    sibling.mkdir()
    monkeypatch.setattr(
        profiles,
        "list_profiles",
        lambda: (_ for _ in ()).throw(AssertionError("sibling scan")),
    )
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


def test_managed_sidebar_reads_only_the_process_profile(
    managed_profile_env, tmp_path, monkeypatch
):
    from fastapi.testclient import TestClient
    from hermes_cli import profiles, web_server
    from hermes_state import SessionDB

    sibling = tmp_path / ".hermes" / "profiles" / "sibling"
    sibling.mkdir()
    for home, session_id in (
        (managed_profile_env, "main-session"),
        (sibling, "sibling-session"),
    ):
        db = SessionDB(home / "state.db")
        try:
            db.create_session(session_id, source="cli")
            db.append_message(session_id, role="user", content="synthetic")
        finally:
            db.close()

    monkeypatch.setattr(
        profiles,
        "profiles_to_serve",
        lambda *, multiplex: (_ for _ in ()).throw(AssertionError("sibling scan")),
    )
    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN

    response = client.get(
        "/api/profiles/sessions/sidebar",
        params={"recents_profile": "all", "recents_exclude": "cron"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert {row["id"] for row in payload["recents"]["sessions"]} == {
        "main-session"
    }


def test_managed_project_and_pull_request_routes_do_not_scan_siblings(
    managed_profile_env, monkeypatch
):
    from fastapi.testclient import TestClient
    from hermes_cli import profiles, web_server

    monkeypatch.setattr(
        profiles,
        "list_profiles",
        lambda: (_ for _ in ()).throw(AssertionError("sibling scan")),
    )
    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN

    projects = client.get("/api/profiles/projects/tree")
    assert projects.status_code == 200
    assert projects.json()["projects"] == []

    pull_requests = client.post(
        "/api/profiles/sessions/pull-requests",
        json={"ids": ["synthetic-session"]},
    )
    assert pull_requests.status_code == 200
    assert pull_requests.json() == {
        "pull_requests": {},
        "scanned": ["synthetic-session"],
    }
