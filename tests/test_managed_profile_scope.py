from pathlib import Path

import pytest

from hermes_constants import get_hermes_home
from hermes_cli import profiles
from hermes_cli.profile_scope import (
    current_effective_profile,
    managed_profile_context,
    principal_from_headers,
    require_profile,
    require_session_profile,
)


def _principal(admin: bool = False):
    return principal_from_headers(
        {
            "x-evaos-allowed-profiles": "jane,louis",
            "x-evaos-primary-profile": "jane",
            "x-evaos-profile-admin": "1" if admin else "0",
            "x-evaos-principal-user": "user-1",
            "x-evaos-session-id": "session-1",
        }
    )


def test_managed_scope_defaults_to_primary_and_rejects_other_profile(monkeypatch, tmp_path):
    # Model the managed flat layout: each service owns one flat
    # ``<managed-root>/<profile>`` home, while sibling lookup remains under
    # ``<managed-root>/profiles``. The real resolver also requires the shared
    # auth path and service identity to agree; keep both synthetic and scoped.
    managed_root = tmp_path / "managed"
    (managed_root / "jane").mkdir(parents=True)
    (managed_root / "louis").mkdir()
    (managed_root / "profiles" / "louis").mkdir(parents=True)
    (managed_root / "shared-auth").mkdir()
    monkeypatch.setattr(profiles, "_get_profiles_root", lambda: managed_root)
    monkeypatch.setenv(
        "HERMES_SHARED_AUTH_FILE", str(managed_root / "shared-auth" / "auth.json")
    )
    monkeypatch.setattr(
        profiles,
        "_effective_service_user",
        lambda: f"hermes-{get_hermes_home().name}",
    )

    with managed_profile_context(_principal()):
        assert require_profile(None) == "jane"
        assert current_effective_profile() == "jane"
        assert profiles.get_profile_dir("default") == managed_root / "jane"
        assert profiles.get_profile_dir("louis") == managed_root / "profiles" / "louis"
        assert profiles.profile_exists("other") is False
        with pytest.raises(PermissionError):
            profiles.get_profile_dir("other")

    with managed_profile_context(_principal(), effective_profile="louis"):
        assert current_effective_profile() == "louis"
        assert require_profile(None) == "louis"


def test_managed_profile_header_rejects_primary_outside_allowlist():
    with pytest.raises(ValueError):
        principal_from_headers(
            {
                "x-evaos-allowed-profiles": "jane,louis",
                "x-evaos-primary-profile": "regan",
                "x-evaos-principal-user": "user-1",
            }
        )


def test_multiplex_profile_selection_requires_assigned_principal(monkeypatch):
    from agent import secret_scope

    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", True)

    with pytest.raises(PermissionError, match="principal is required"):
        require_profile("jane")


@pytest.mark.parametrize("recorded_profile", [None, "louis"])
def test_managed_session_profile_refuses_unassigned_or_conflicting_record(
    recorded_profile,
):
    with managed_profile_context(_principal(admin=True), effective_profile="jane"):
        with pytest.raises(PermissionError, match="session profile"):
            require_session_profile(recorded_profile)


def test_managed_admin_can_open_session_in_effective_profile():
    with managed_profile_context(_principal(admin=True), effective_profile="louis"):
        assert require_session_profile("louis") == "louis"
