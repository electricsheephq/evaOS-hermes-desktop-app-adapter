"""Unit tests for hermes_cli.managed_scope (resolver + loaders + key helpers)."""
import textwrap
from types import SimpleNamespace

import pytest


def test_operator_owned_fails_closed_off_posix(monkeypatch):
    from hermes_cli import managed_scope

    manifest = SimpleNamespace(source="user", path="/managed/plugin")
    monkeypatch.setattr(managed_scope.os, "name", "nt")
    monkeypatch.setattr(
        managed_scope.os,
        "lstat",
        lambda _path: pytest.fail("lstat must not run off POSIX"),
    )

    assert managed_scope._operator_owned(manifest) is False


def test_operator_owned_uses_symlink_ownership(monkeypatch):
    from hermes_cli import managed_scope

    manifest = SimpleNamespace(source="user", path="/managed/plugin")
    monkeypatch.setattr(managed_scope.os, "name", "posix")
    monkeypatch.setattr(
        managed_scope.os, "lstat", lambda _path: SimpleNamespace(st_uid=1000)
    )
    monkeypatch.setattr(
        managed_scope.os, "stat", lambda _path: SimpleNamespace(st_uid=0)
    )

    assert managed_scope._operator_owned(manifest) is False


# ── Directory resolver ───────────────────────────────────────────────────────






# ── Loaders + key helpers ────────────────────────────────────────────────────


def _write_managed(tmp_path, monkeypatch, *, config=None, env=None):
    from hermes_cli import managed_scope

    managed = tmp_path / "managed"
    managed.mkdir(exist_ok=True)
    if config is not None:
        (managed / "config.yaml").write_text(textwrap.dedent(config), encoding="utf-8")
    if env is not None:
        (managed / ".env").write_text(textwrap.dedent(env), encoding="utf-8")
    monkeypatch.setenv("HERMES_MANAGED_DIR", str(managed))
    managed_scope.invalidate_managed_cache()
    return managed








def test_load_managed_env_and_is_env_managed(tmp_path, monkeypatch):
    from hermes_cli import managed_scope

    _write_managed(
        tmp_path, monkeypatch, env="OPENAI_API_BASE=https://org.example/v1\n"
    )
    assert managed_scope.load_managed_env() == {
        "OPENAI_API_BASE": "https://org.example/v1"
    }
    assert managed_scope.is_env_managed("OPENAI_API_BASE") is True
    assert managed_scope.is_env_managed("OTHER") is False




def test_managed_dir_env_scrubbed_by_default():
    """conftest must scrub HERMES_MANAGED_DIR so a dev-shell value can't leak in."""
    import os

    assert "HERMES_MANAGED_DIR" not in os.environ
