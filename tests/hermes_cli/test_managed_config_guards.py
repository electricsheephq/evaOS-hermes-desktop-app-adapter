"""Managed-scope config guards that need no predecessor checkout.

Kept from the retired r31 compatibility suite (tests/r31_compat/test_state_config_compat.py) when
its r30.7 predecessor pair was retired: a managed ``migrate_config`` must not mutate the profile's
dotenv, and the managed-authority keys are refused by the env writer before managed scope is read.
The cross-version managed-dir guard against the r33.6 predecessor is tests/r34_compat/.
"""


def test_managed_migrate_config_validates_then_preserves_disk(monkeypatch, tmp_path):
    from hermes_cli import config, managed_scope

    managed_dir = tmp_path / "managed"
    managed_dir.mkdir()
    monkeypatch.setenv("HERMES_MANAGED_DIR", str(managed_dir))
    managed_scope.invalidate_managed_cache()

    monkeypatch.setattr(config, "check_config_version", lambda **_: (39, 40))
    monkeypatch.setattr(
        config,
        "sanitize_env_file",
        lambda: (_ for _ in ()).throw(AssertionError("managed migration mutated dotenv")),
    )

    result = config.migrate_config(interactive=False, quiet=True)

    assert result == {"env_added": [], "config_added": [], "warnings": []}


def test_managed_authority_keys_are_write_denied_before_scope_lookup(monkeypatch):
    from hermes_cli import config, managed_scope

    monkeypatch.setattr(managed_scope, "get_managed_dir", lambda: (_ for _ in ()).throw(
        AssertionError("protected key consulted managed scope")
    ))
    for key in ("HERMES_MANAGED_DIR", "HERMES_SHARED_AUTH_FILE", "CREDENTIALS_DIRECTORY"):
        try:
            config.validate_env_var_name_for_write(key)
        except ValueError as exc:
            assert "denylist" in str(exc)
        else:
            raise AssertionError(f"{key} was accepted by the writer denylist")
