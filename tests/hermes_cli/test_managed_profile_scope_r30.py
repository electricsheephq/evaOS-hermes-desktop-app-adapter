import os
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.fixture
def flat_managed_profile(tmp_path, monkeypatch):
    root = tmp_path / "hermes"
    home = root / "main"
    home.mkdir(parents=True)
    shared = root / "shared-auth" / "auth.json"
    shared.parent.mkdir()
    shared.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared))
    import pwd

    monkeypatch.setattr(os, "geteuid", lambda: 4242)
    monkeypatch.setattr(pwd, "getpwuid", lambda _uid: SimpleNamespace(pw_name="hermes-main"))
    return home


def test_flat_profile_is_the_only_resolvable_owner(flat_managed_profile):
    from hermes_cli import profiles
    from hermes_cli.managed_profile_scope import (
        ManagedProfileScopeError,
        managed_profile_name,
        require_managed_profile,
    )

    assert managed_profile_name() == "main"
    assert profiles.get_active_profile_name() == "main"
    assert profiles.get_profile_dir("main") == flat_managed_profile
    assert profiles.get_profile_dir("default") == flat_managed_profile
    assert profiles.profile_matches_home("main") is True
    assert profiles.profile_matches_home("default") is False
    assert profiles.list_profile_names() == ["main"]
    assert [info.name for info in profiles.list_profiles()] == ["main"]
    assert profiles.profiles_to_serve(multiplex=True) == [("main", flat_managed_profile)]
    assert require_managed_profile(None) == "main"
    with pytest.raises(ManagedProfileScopeError, match="not authorized"):
        require_managed_profile("sibling")


def test_flat_profile_lifecycle_is_owner_managed(flat_managed_profile):
    from hermes_cli import profiles

    with pytest.raises(ValueError, match="profile lifecycle is managed by evaOS"):
        profiles.delete_profile("main", yes=True)
    with pytest.raises(ValueError, match="profile lifecycle is managed by evaOS"):
        profiles.rename_profile("main", "renamed")
    assert flat_managed_profile.is_dir()


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


@pytest.fixture
def flat_managed_default_profile_env(tmp_path, monkeypatch):
    root = tmp_path / ".hermes"
    profile_home = root / "default"
    profile_home.mkdir(parents=True)
    shared_auth = root / "shared-auth" / "auth.json"
    shared_auth.parent.mkdir()
    shared_auth.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(profile_home))
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared_auth))
    import pwd

    monkeypatch.setattr(os, "geteuid", lambda: 4242)
    monkeypatch.setattr(pwd, "getpwuid", lambda _uid: SimpleNamespace(pw_name="hermes-default"))
    return root, profile_home


def test_r30_managed_profile_scope_is_bound_to_process_home(managed_profile_env):
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


def test_r30_flat_managed_default_is_literal_owner_and_denies_siblings(
    flat_managed_default_profile_env,
):
    from gateway.platforms.api_server import _prefix_names_served_profile
    from hermes_cli import profiles
    from hermes_cli.managed_profile_scope import (
        ManagedProfileScopeError,
        managed_profile_name,
        require_managed_profile,
    )

    _root, profile_home = flat_managed_default_profile_env
    assert managed_profile_name() == "default"
    assert profiles.get_active_profile_name() == "default"
    assert profiles.get_profile_dir("default") == profile_home
    assert profiles.resolve_profile_env("default") == str(profile_home)
    assert profiles.profile_matches_home("default") is True
    assert profiles.profile_matches_home("sibling") is False
    assert profiles.list_profile_names() == ["default"]
    listed = profiles.list_profiles()
    assert [(item.name, item.path, item.is_default) for item in listed] == [
        ("default", profile_home, True)
    ]
    assert _prefix_names_served_profile("default") is True
    assert require_managed_profile(None) == "default"
    assert require_managed_profile("current") == "default"
    assert require_managed_profile("default") == "default"
    for selector in ("main", "sibling"):
        with pytest.raises(ManagedProfileScopeError, match="not authorized"):
            require_managed_profile(selector)


def test_r30_flat_managed_default_session_create_reports_default_without_nested_redirect(
    flat_managed_default_profile_env, monkeypatch
):
    from tui_gateway import server

    _root, profile_home = flat_managed_default_profile_env
    monkeypatch.setattr(server, "_hermes_home", profile_home)
    monkeypatch.setattr(server, "_schedule_agent_build", lambda *args, **kwargs: None)
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda *args, **kwargs: None)
    monkeypatch.setattr(server, "_completion_cwd", lambda params=None: str(profile_home))

    response = server._methods["session.create"](
        "flat-default-session", {"profile": "default", "cols": 80}
    )
    assert "result" in response, response
    assert response["result"]["info"]["profile_name"] == "default"
    sid = response["result"]["session_id"]
    try:
        assert server._sessions[sid]["profile_home"] is None
        assert server._profile_home("default") is None
    finally:
        with server._sessions_lock:
            server._sessions.pop(sid, None)


def test_r30_flat_managed_default_multiplex_stays_owner_only_with_nested_sibling(
    flat_managed_default_profile_env,
):
    from gateway.platforms.api_server import APIServerAdapter, _PROFILE_REJECTED
    from hermes_cli import profiles

    _root, profile_home = flat_managed_default_profile_env
    sibling = profile_home.parent / "profiles" / "sibling"
    sibling.mkdir(parents=True)

    assert profiles.profiles_to_serve(multiplex=True) == [("default", profile_home)]

    adapter = object.__new__(APIServerAdapter)
    adapter.gateway_runner = SimpleNamespace(
        config=SimpleNamespace(multiplex_profiles=True, multiplex_profile_allowlist=None)
    )
    request = SimpleNamespace(match_info={"profile": "sibling"})
    assert adapter._resolve_request_profile(request) is _PROFILE_REJECTED


def test_r30_flat_managed_profile_resolves_and_lists_only_current_identity(
    flat_managed_profile,
):
    from hermes_cli import profiles

    assert profiles.resolve_profile_env("main") == str(flat_managed_profile)
    assert profiles.list_profile_names() == ["main"]
    listed = profiles.list_profiles()
    assert [item.name for item in listed] == ["main"]
    assert [item.path for item in listed] == [flat_managed_profile]
    assert listed[0].is_default is False


def test_r30_flat_managed_explicit_selector_preserves_configured_symlink_spelling(
    flat_managed_profile, tmp_path, monkeypatch
):
    from hermes_cli import profiles

    launch_root = tmp_path / "launch"
    launch_root.mkdir()
    configured_home = launch_root / "main"
    configured_home.symlink_to(flat_managed_profile, target_is_directory=True)
    monkeypatch.setenv("HERMES_HOME", str(configured_home))
    assert profiles.resolve_profile_env("main") == str(configured_home)


def test_r30_flat_managed_profile_lifecycle_cannot_remove_or_rename_active_home(
    flat_managed_profile,
):
    from hermes_cli import profiles

    with pytest.raises(ValueError, match="profile lifecycle is managed by evaOS"):
        profiles.delete_profile("main", yes=True)
    with pytest.raises(ValueError, match="profile lifecycle is managed by evaOS"):
        profiles.rename_profile("main", "renamed")
    with pytest.raises(ValueError, match="profile lifecycle is managed by evaOS"):
        profiles.rename_profile("default", "renamed")
    assert flat_managed_profile.is_dir()


def test_r30_flat_managed_profile_requires_matching_service_user(flat_managed_profile, monkeypatch):
    from hermes_cli import profiles
    import pwd

    monkeypatch.setattr(pwd, "getpwuid", lambda _uid: SimpleNamespace(pw_name="hermes-sibling"))
    assert profiles.get_active_profile_name() != "main"
    assert profiles.profile_matches_home("main") is False


def test_r30_flat_managed_profile_requires_shared_auth_root(flat_managed_profile, tmp_path, monkeypatch):
    from hermes_cli import profiles

    other_auth = tmp_path / "other-hermes" / "shared-auth" / "auth.json"
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(other_auth))
    assert profiles.get_active_profile_name() != "main"
    assert profiles.profile_matches_home("main") is False
    assert profiles.get_profile_dir("main") != flat_managed_profile


def test_r30_nested_managed_profile_resolution_stays_upstream(managed_profile_env):
    from hermes_cli import profiles

    assert profiles.get_active_profile_name() == "main"
    assert profiles.get_profile_dir("main") == managed_profile_env
    assert profiles.profile_matches_home("main") is True


def test_r30_flat_managed_session_create_reports_main_without_nested_redirect(
    flat_managed_profile, monkeypatch
):
    from tui_gateway import server

    monkeypatch.setattr(server, "_hermes_home", flat_managed_profile)
    monkeypatch.setattr(server, "_schedule_agent_build", lambda *args, **kwargs: None)
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda *args, **kwargs: None)
    monkeypatch.setattr(server, "_completion_cwd", lambda params=None: str(flat_managed_profile))

    response = server._methods["session.create"](
        "flat-session", {"profile": "main", "cols": 80}
    )
    assert "result" in response, response
    assert response["result"]["info"]["profile_name"] == "main"
    sid = response["result"]["session_id"]
    try:
        assert server._sessions[sid]["profile_home"] is None
        assert server._profile_home("main") is None
    finally:
        with server._sessions_lock:
            server._sessions.pop(sid, None)


def test_r30_unmanaged_scope_preserves_upstream_selectors(monkeypatch):
    from hermes_cli.managed_profile_scope import require_managed_profile

    monkeypatch.delenv("HERMES_SHARED_AUTH_FILE", raising=False)
    assert require_managed_profile("sibling") == "sibling"
    assert require_managed_profile("all", selectors_for_current=("all",)) == "all"


def test_r30_managed_default_home_fails_closed(tmp_path, monkeypatch):
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


def test_r30_managed_current_hub_selector_validates_process_home(managed_profile_env, tmp_path, monkeypatch):
    from fastapi import HTTPException
    from hermes_cli import web_server_profiles

    assert web_server_profiles._profile_cli_args(None) == []
    assert web_server_profiles._profile_cli_args("current") == []

    monkeypatch.setenv("HERMES_HOME", str(tmp_path / ".hermes"))
    for selector in (None, "current"):
        with pytest.raises(HTTPException) as exc_info:
            web_server_profiles._profile_cli_args(selector)
        assert exc_info.value.status_code == 503
        assert exc_info.value.detail == "managed gateway is not bound to a named profile"


def test_r30_managed_current_export_uses_process_profile(managed_profile_env, tmp_path, monkeypatch):
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
    response = client.post("/api/profiles/current/export", json={"output": str(output)})

    assert response.status_code == 200
    assert response.json() == {"ok": True, "archive": str(output)}
    assert calls == [("main", str(output), None)]


def test_r30_managed_current_profile_actions_use_canonical_process_name(managed_profile_env, monkeypatch):
    from fastapi.testclient import TestClient
    from hermes_cli import profile_describer, web_server

    calls = []

    def fake_describe(name, *, overwrite=False):
        calls.append((name, overwrite))
        return profile_describer.DescribeOutcome(
            profile_name=name, ok=True, description="synthetic description"
        )

    monkeypatch.setattr(profile_describer, "describe_profile", fake_describe)
    client = TestClient(web_server.app)
    client.headers[web_server._SESSION_HEADER_NAME] = web_server._SESSION_TOKEN
    setup = client.get("/api/profiles/current/setup-command")
    assert setup.status_code == 200
    assert setup.json() == {"command": "main setup"}
    described = client.post("/api/profiles/current/describe-auto", json={"overwrite": True})
    assert described.status_code == 200
    assert calls == [("main", True)]


def test_r30_managed_named_process_skips_default_multiplex_scope(managed_profile_env, monkeypatch):
    from gateway.config import PORT_BINDING_PLATFORM_VALUES
    from hermes_cli.web_routers import messaging

    monkeypatch.setattr(
        messaging,
        "_config_profile_scope",
        lambda _profile: (_ for _ in ()).throw(
            AssertionError("managed process entered default multiplex scope")
        ),
    )
    platform_id = sorted(PORT_BINDING_PLATFORM_VALUES)[0]
    assert messaging._multiplex_port_binding_conflict(platform_id, "current") is None


def test_r30_dashboard_and_tui_reject_sibling_profile(managed_profile_env, monkeypatch):
    from fastapi import HTTPException
    from hermes_cli import web_server_profiles
    from tui_gateway import server as tui_server

    with pytest.raises(HTTPException) as exc_info:
        web_server_profiles._resolve_profile_dir("sibling")
    assert exc_info.value.status_code == 403

    monkeypatch.setattr(tui_server, "_hermes_home", str(managed_profile_env))
    with pytest.raises(PermissionError, match="not authorized"):
        tui_server._profile_home("sibling")
    assert tui_server._profile_home("main") is None


def test_r30_managed_gateway_rejects_reserved_default_selector(managed_profile_env):
    from fastapi import HTTPException
    from hermes_cli.web_server_gateway import _gateway_subcommand

    with pytest.raises(HTTPException) as exc_info:
        _gateway_subcommand("default", "start")
    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "profile is not authorized"


def test_r30_unmanaged_gateway_preserves_upstream_default_selector(monkeypatch):
    from hermes_cli.web_server_gateway import _gateway_subcommand

    monkeypatch.delenv("HERMES_SHARED_AUTH_FILE", raising=False)
    assert _gateway_subcommand("default", "start") == ["gateway", "start"]


def test_r30_managed_dashboard_exposes_only_its_profile(managed_profile_env, tmp_path, monkeypatch):
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


def test_r30_managed_sidebar_reads_only_the_process_profile(managed_profile_env, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from hermes_cli import profiles, web_server
    from hermes_state import SessionDB

    sibling = tmp_path / ".hermes" / "profiles" / "sibling"
    sibling.mkdir()
    for home, session_id in ((managed_profile_env, "main-session"), (sibling, "sibling-session")):
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
    assert {row["id"] for row in response.json()["recents"]["sessions"]} == {"main-session"}


def test_r30_managed_project_and_pull_request_routes_do_not_scan_siblings(
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
        "/api/profiles/sessions/pull-requests", json={"ids": ["synthetic-session"]}
    )
    assert pull_requests.status_code == 200
    assert pull_requests.json() == {
        "pull_requests": {}, "scanned": ["synthetic-session"]
    }
