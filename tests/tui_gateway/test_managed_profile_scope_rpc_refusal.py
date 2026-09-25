"""A managed gateway answers an out-of-scope profile request with a typed refusal.

``_profile_home`` resolves every ws request's profile through
``require_managed_profile``, which raises ``ManagedProfileScopeError`` (a
``PermissionError``) when the request names a sibling of the process's own
profile.  Nothing on the ws path caught it, so the exception escaped
``dispatch`` and the read loop answered the generic ``-32603 internal error``
with a logged traceback — an ordinary authorization outcome reported as a
server fault.  ``handle_request`` now mirrors the dashboard's 403
(``hermes_cli.web_server_profiles._managed_profile_or_http``) as JSON-RPC
``4030 "profile is not authorized"``.
"""
from pathlib import Path

import pytest


@pytest.fixture
def managed_gateway(tmp_path, monkeypatch):
    """One managed gateway process bound to the profile ``main``."""
    from hermes_state import SessionDB
    from tui_gateway import server

    default_home = tmp_path / ".hermes"
    profile_home = default_home / "profiles" / "main"
    profile_home.mkdir(parents=True)
    sibling = default_home / "profiles" / "sibling"
    sibling.mkdir(parents=True)
    shared_auth = default_home / "shared-auth" / "auth.json"
    shared_auth.parent.mkdir()
    shared_auth.write_text("{}", encoding="utf-8")
    for path, marker in ((profile_home, "main"), (sibling, "sibling")):
        (path / "config.yaml").write_text(f"terminal:\n  cwd: /{marker}\n")
        with SessionDB(db_path=path / "state.db") as db:
            db.create_session(marker, "tui")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(profile_home))
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared_auth))
    monkeypatch.setattr(server, "_hermes_home", profile_home)
    return server


def _request(method: str, params: dict) -> dict:
    return {"jsonrpc": "2.0", "id": 7, "method": method, "params": params}


def test_out_of_scope_profile_is_a_typed_refusal(managed_gateway):
    """The sibling profile this process does not own is refused as 4030, not -32603."""
    from hermes_cli.managed_profile_scope import (
        ManagedProfileScopeError,
        require_managed_profile,
    )

    # Precondition: the resolver really does refuse the sibling here.
    with pytest.raises(ManagedProfileScopeError):
        require_managed_profile("sibling")

    response = managed_gateway.handle_request(
        _request("config.get", {"profile": "sibling", "key": "full"}))

    assert response["error"]["code"] == 4030
    assert response["error"]["message"] == "profile is not authorized"
    assert response["id"] == 7
    assert "result" not in response


def test_in_scope_profile_is_unchanged(managed_gateway):
    """The process's own profile still answers normally."""
    for selector in (None, "main", "current"):
        response = managed_gateway.handle_request(
            _request("config.get", {"profile": selector, "key": "full"}))
        assert "error" not in response, selector
        assert response["result"]["config"]["terminal"]["cwd"] == "/main"


def test_unmanaged_gateway_keeps_multi_profile_behaviour(tmp_path, monkeypatch):
    """Without the managed binding, a sibling profile resolves as it always did."""
    from hermes_state import SessionDB
    from tui_gateway import server

    home = tmp_path / ".hermes"
    sibling = home / "profiles" / "sibling"
    sibling.mkdir(parents=True)
    for path, marker in ((home, "launch"), (sibling, "sibling")):
        (path / "config.yaml").write_text(f"terminal:\n  cwd: /{marker}\n")
        with SessionDB(db_path=path / "state.db") as db:
            db.create_session(marker, "tui")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("HERMES_SHARED_AUTH_FILE", raising=False)
    monkeypatch.setattr(server, "_hermes_home", home)

    response = server.handle_request(
        _request("config.get", {"profile": "sibling", "key": "full"}))

    assert "error" not in response
    assert response["result"]["config"]["terminal"]["cwd"] == "/sibling"
