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
