"""Tests for nested/alias-normalized enable & disable flows.

Companion to test_plugins_cmd_category_discovery.py. That file covers the
*listing* side of nested category plugins (issue #41066). These tests cover
the *mutation* side: `hermes plugins enable/disable` must resolve a bare name
OR a full path-derived key (e.g. `observability/trace_sink`) to the canonical
registry key and write THAT — the same string PluginManager gates on — so a
nested bundled plugin can actually be toggled.
"""

import sys  # noqa: F401
from pathlib import Path
from unittest.mock import patch

import pytest


def _make_plugin_dir(parent: Path, name: str, manifest: dict) -> Path:
    d = parent / name
    d.mkdir(parents=True, exist_ok=True)
    import yaml
    (d / "plugin.yaml").write_text(yaml.dump(manifest), encoding="utf-8")
    (d / "__init__.py").write_text("def register(ctx): pass\n", encoding="utf-8")
    return d


def _make_category_plugin(parent: Path, category: str, name: str, manifest: dict) -> Path:
    return _make_plugin_dir(parent / category, name, manifest)


@pytest.fixture
def nested_plugin_env(tmp_path):
    """A user-plugins dir containing one nested and one flat plugin, with the
    bundled dir pointed at an empty path. Returns the tmp_path."""
    _make_category_plugin(tmp_path, "observability", "trace_sink", {
        "name": "trace_sink", "version": "1.0.0", "description": "trace sink"
    })
    _make_plugin_dir(tmp_path, "disk-cleanup", {
        "name": "disk-cleanup", "version": "1.0.0"
    })
    return tmp_path


@pytest.fixture
def managed_plugin_policy(tmp_path, monkeypatch):
    from hermes_cli import managed_scope

    managed_dir = tmp_path / "managed"
    managed_dir.mkdir()
    (managed_dir / "config.yaml").write_text(
        "plugins:\n  enabled: [required]\n  disabled: [blocked]\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_MANAGED_DIR", str(managed_dir))
    managed_scope.invalidate_managed_cache()
    yield
    managed_scope.invalidate_managed_cache()


# ---------------------------------------------------------------------------
# _resolve_plugin_key
# ---------------------------------------------------------------------------


class TestResolvePluginKey:
    @patch("hermes_cli.plugins.get_bundled_plugins_dir")
    @patch("hermes_cli.plugins_cmd._plugins_dir")
    def test_full_key_resolves_to_itself(self, mock_user, mock_bundled, nested_plugin_env):
        from hermes_cli.plugins_cmd import _resolve_plugin_key
        mock_user.return_value = nested_plugin_env
        mock_bundled.return_value = nested_plugin_env / "nonexistent"
        assert _resolve_plugin_key("observability/trace_sink") == "observability/trace_sink"


    @patch("hermes_cli.plugins.get_bundled_plugins_dir")
    @patch("hermes_cli.plugins_cmd._plugins_dir")
    def test_unknown_returns_none(self, mock_user, mock_bundled, nested_plugin_env):
        from hermes_cli.plugins_cmd import _resolve_plugin_key
        mock_user.return_value = nested_plugin_env
        mock_bundled.return_value = nested_plugin_env / "nonexistent"
        assert _resolve_plugin_key("does-not-exist") is None

    @patch("hermes_cli.plugins.get_bundled_plugins_dir")
    @patch("hermes_cli.plugins_cmd._plugins_dir")
    def test_ambiguous_leaf_name_returns_none(self, mock_user, mock_bundled, tmp_path):
        """Same leaf name under two categories must NOT silently pick one."""
        from hermes_cli.plugins_cmd import _resolve_plugin_key
        _make_category_plugin(tmp_path, "image_gen", "openai", {"name": "image-gen-openai"})
        _make_category_plugin(tmp_path, "model-providers", "openai", {"name": "mp-openai"})
        mock_user.return_value = tmp_path
        mock_bundled.return_value = tmp_path / "nonexistent"
        # Bare "openai" is ambiguous -> None; the full key still resolves.
        assert _resolve_plugin_key("openai") is None
        assert _resolve_plugin_key("image_gen/openai") == "image_gen/openai"


# ---------------------------------------------------------------------------
# cmd_enable / cmd_disable — write the canonical key
# ---------------------------------------------------------------------------


class TestEnableDisableNested:
    def test_disable_then_enable_persists_profile_selection(
        self, tmp_path, monkeypatch, managed_plugin_policy
    ):
        from hermes_cli import plugins, plugins_cmd
        from hermes_cli.config import read_raw_config

        home = tmp_path / "home"
        home.mkdir()
        (home / "config.yaml").write_text(
            "plugins:\n  enabled: [example]\n  disabled: []\n",
            encoding="utf-8",
        )
        bundled = tmp_path / "bundled"
        _make_plugin_dir(bundled, "example", {"name": "example", "version": "1.0.0"})
        monkeypatch.setenv("HERMES_HOME", str(home))
        monkeypatch.setattr(plugins, "get_bundled_plugins_dir", lambda: bundled)

        plugins_cmd.cmd_disable("example")
        plugins_cmd.cmd_enable("example")

        saved = read_raw_config()["plugins"]
        assert "example" in saved["enabled"]
        assert "example" not in saved["disabled"]

    def test_enable_managed_denied_reports_effective_state(
        self, monkeypatch, capsys, managed_plugin_policy
    ):
        from hermes_cli import plugins_cmd

        monkeypatch.setattr(
            plugins_cmd,
            "_resolve_plugin_key_and_source",
            lambda _name: ("blocked", "bundled"),
        )
        monkeypatch.setattr(plugins_cmd, "_get_enabled_set", lambda: set())
        monkeypatch.setattr(plugins_cmd, "_get_disabled_set", lambda: {"blocked"})
        monkeypatch.setattr(plugins_cmd, "_discover_all_plugins", lambda: [])
        monkeypatch.setattr(plugins_cmd, "_save_plugin_sets", lambda *_args: None)

        plugins_cmd.cmd_enable("blocked")

        output = capsys.readouterr().out
        assert "is denied by managed policy; it stays disabled" in output
        assert "enabled. Takes effect when the Hermes agent" not in output

    def test_disable_managed_required_reports_effective_state(
        self, monkeypatch, capsys, managed_plugin_policy
    ):
        from hermes_cli import plugins_cmd

        monkeypatch.setattr(plugins_cmd, "_resolve_plugin_key", lambda _name: "required")
        monkeypatch.setattr(plugins_cmd, "_get_enabled_set", lambda: {"required"})
        monkeypatch.setattr(plugins_cmd, "_get_disabled_set", lambda: set())
        monkeypatch.setattr(plugins_cmd, "_save_plugin_sets", lambda *_args: None)

        plugins_cmd.cmd_disable("required")

        output = capsys.readouterr().out
        assert "is required by managed policy; it stays enabled" in output
        assert "disabled. Takes effect when the Hermes agent" not in output

    @patch("hermes_cli.plugins.get_bundled_plugins_dir")
    @patch("hermes_cli.plugins_cmd._plugins_dir")
    @patch("hermes_cli.plugins_cmd._save_plugin_sets")
    @patch("hermes_cli.plugins_cmd._get_disabled_set", return_value=set())
    @patch("hermes_cli.plugins_cmd._get_enabled_set", return_value=set())
    def test_enable_bare_name_writes_key(
        self, mock_en, mock_dis, mock_save,
        mock_user, mock_bundled, nested_plugin_env,
    ):
        from hermes_cli.plugins_cmd import cmd_enable
        mock_user.return_value = nested_plugin_env
        mock_bundled.return_value = nested_plugin_env / "nonexistent"

        cmd_enable("trace_sink", allow_tool_override=False)  # bare name

        saved = mock_save.call_args[0][0]
        # The canonical key — NOT the bare name — must be persisted, because
        # that is what PluginManager matches when deciding to load.
        assert "observability/trace_sink" in saved
        assert "trace_sink" not in saved or "observability/trace_sink" in saved


    @patch("hermes_cli.plugins.get_bundled_plugins_dir")
    @patch("hermes_cli.plugins_cmd._plugins_dir")
    def test_enable_unknown_plugin_exits(self, mock_user, mock_bundled, nested_plugin_env):
        from hermes_cli.plugins_cmd import cmd_enable
        mock_user.return_value = nested_plugin_env
        mock_bundled.return_value = nested_plugin_env / "nonexistent"
        with pytest.raises(SystemExit):
            cmd_enable("does-not-exist")



# ---------------------------------------------------------------------------
# cmd_enable — built-in tool override consent (issue #29249)
# ---------------------------------------------------------------------------


class TestEnableToolOverrideConsent:
    """Default enable without declared capabilities must neither prompt for
    tool override nor write a grant; explicit choices are covered separately."""


    @patch("hermes_cli.plugins.get_bundled_plugins_dir")
    @patch("hermes_cli.plugins_cmd._plugins_dir")
    @patch("hermes_cli.plugins_cmd._set_plugin_entry_flag")
    @patch("hermes_cli.plugins_cmd._save_disabled_set")
    @patch("hermes_cli.plugins_cmd._save_enabled_set")
    @patch("hermes_cli.plugins_cmd._get_disabled_set", return_value=set())
    @patch("hermes_cli.plugins_cmd._get_enabled_set", return_value=set())
    def test_no_capabilities_skips_prompt_and_grant_write(
        self, mock_en, mock_dis, mock_save_en, mock_save_dis, mock_set_flag,
        mock_user, mock_bundled, nested_plugin_env,
    ):
        """No explicit grant choice means no prompt, even with EOF-only stdin."""
        from hermes_cli.plugins_cmd import cmd_enable
        mock_user.return_value = nested_plugin_env
        mock_bundled.return_value = nested_plugin_env / "nonexistent"

        # evaOS adaptation (r34): the fork persists both plugin lists in one save
        # (_save_plugin_sets) so a disable→enable cycle cannot lose the selection (R5).
        with patch("rich.console.Console.input", side_effect=EOFError) as prompt, \
                patch("hermes_cli.plugins_cmd._save_plugin_sets") as mock_save_sets:
            cmd_enable("disk-cleanup")

        prompt.assert_not_called()
        mock_set_flag.assert_not_called()
        assert "disk-cleanup" in mock_save_sets.call_args[0][0]

    @patch("hermes_cli.plugins.get_bundled_plugins_dir")
    @patch("hermes_cli.plugins_cmd._plugins_dir")
    @patch("hermes_cli.plugins_cmd._set_plugin_entry_flag")
    @patch("hermes_cli.plugins_cmd._save_disabled_set")
    @patch("hermes_cli.plugins_cmd._save_enabled_set")
    @patch("hermes_cli.plugins_cmd._get_disabled_set", return_value=set())
    @patch("hermes_cli.plugins_cmd._get_enabled_set", return_value=set())
    def test_bundled_plugin_never_prompts_or_writes_entry(
        self, mock_en, mock_dis, mock_save_en, mock_save_dis, mock_set_flag,
        mock_user, mock_bundled, tmp_path,
    ):
        """Bundled plugins are trusted — no consent prompt, no entry write."""
        from hermes_cli.plugins_cmd import cmd_enable
        # Bundled dir holds the plugin; user dir is empty.
        _make_plugin_dir(tmp_path / "bundled", "trusted_bundled", {
            "name": "trusted_bundled", "version": "1.0.0",
        })
        mock_user.return_value = tmp_path / "empty"
        mock_bundled.return_value = tmp_path / "bundled"

        # Console.input would raise if called — proving no prompt fired.
        with patch("rich.console.Console.input", side_effect=AssertionError("prompted")):
            cmd_enable("trusted_bundled")

        mock_set_flag.assert_not_called()


class TestCompositeMenuWritesCanonicalKey:
    """#40190 follow-up: the interactive `hermes plugins` menu must persist
    the CANONICAL KEY (``web/firecrawl``), never the bare manifest name
    (``web-firecrawl``), so its disabled-list entries stay aligned with what
    ``cmd_enable`` clears and what PluginManager gates on. Writing the bare
    name is what silently vetoed a bundled backend forever (pi314).
    """

    @patch("hermes_cli.plugins_cmd._save_plugin_sets")
    @patch("hermes_cli.plugins_cmd._get_enabled_set", return_value=set())
    def test_fallback_unchecked_plugin_disables_by_key_not_name(
        self, mock_en, mock_save,
    ):
        from hermes_cli.plugins_cmd import _run_composite_fallback
        from rich.console import Console

        # key differs from the manifest name, mirroring web/firecrawl.
        plugin_keys = ["web/firecrawl"]
        plugin_labels = ["web-firecrawl — firecrawl [bundled]"]
        plugin_selected = set()  # unchecked → should be disabled

        # First input() toggles nothing (blank Enter confirms immediately),
        # second (category prompt) is skipped with blank Enter.
        with patch("builtins.input", return_value=""):
            _run_composite_fallback(
                plugin_keys, plugin_labels, plugin_selected,
                set(), [], Console(),
            )

        saved_dis = mock_save.call_args[0][1]
        assert "web/firecrawl" in saved_dis      # canonical key persisted
        assert "web-firecrawl" not in saved_dis   # never the bare name
