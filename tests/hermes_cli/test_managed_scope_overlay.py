"""apply_managed_overlay() — the shared helper used by every standalone loader."""
import logging
import textwrap

import pytest


@pytest.fixture
def managed(tmp_path, monkeypatch):
    md = tmp_path / "managed"
    md.mkdir()
    monkeypatch.setenv("HERMES_MANAGED_DIR", str(md))
    from hermes_cli import managed_scope

    managed_scope.invalidate_managed_cache()
    return md


def _write(md, body):
    (md / "config.yaml").write_text(textwrap.dedent(body), encoding="utf-8")
    from hermes_cli import managed_scope

    managed_scope.invalidate_managed_cache()


def test_overlay_noop_without_scope(tmp_path, monkeypatch):
    from hermes_cli import managed_scope

    monkeypatch.setenv("HERMES_MANAGED_DIR", str(tmp_path / "nope"))
    managed_scope.invalidate_managed_cache()
    src = {"display": {"skin": "user"}}
    assert managed_scope.apply_managed_overlay(src) == {"display": {"skin": "user"}}


def test_overlay_preserves_user_siblings(managed):
    from hermes_cli import managed_scope

    _write(managed, "display:\n  skin: charizard\n")
    out = managed_scope.apply_managed_overlay(
        {"display": {"skin": "user", "show_reasoning": True}}
    )
    assert out["display"]["skin"] == "charizard"
    assert out["display"]["show_reasoning"] is True


def test_overlay_composes_plugin_lists_with_managed_deny_winning(managed):
    from hermes_cli import managed_scope

    _write(
        managed,
        """
        plugins:
          enabled: [managed, denied]
          disabled: [denied, managed-off]
        """,
    )
    out = managed_scope.apply_managed_overlay(
        {"plugins": {"enabled": ["profile", "denied"], "disabled": ["profile-off"]}}
    )

    assert out["plugins"]["enabled"] == ["managed", "profile"]
    assert out["plugins"]["disabled"] == ["denied", "managed-off", "profile-off"]


def test_overlay_managed_authority_wins_plugin_selection_conflicts(managed, caplog):
    from hermes_cli import managed_scope

    _write(
        managed,
        """
        plugins:
          enabled: [required]
          disabled: [blocked]
        """,
    )

    with caplog.at_level(logging.WARNING):
        out = managed_scope.apply_managed_overlay(
            {
                "plugins": {
                    "enabled": ["blocked", "profile-only"],
                    "disabled": ["required", "profile-only"],
                }
            }
        )

    assert out["plugins"]["enabled"] == ["required"]
    assert out["plugins"]["disabled"] == ["blocked", "profile-only"]
    assert caplog.text.count("required") == 1


def test_overlay_without_managed_scope_keeps_plugin_object_identity(tmp_path, monkeypatch):
    from hermes_cli import managed_scope

    monkeypatch.setenv("HERMES_MANAGED_DIR", str(tmp_path / "missing"))
    managed_scope.invalidate_managed_cache()
    src = {"plugins": {"enabled": ["profile"], "disabled": ["off"]}}

    assert managed_scope.apply_managed_overlay(src) is src
