"""Tests for `/reload-skills` resyncing the Discord ``/skill`` autocomplete.

Before this change, ``_register_skill_group`` captured the skill catalog
in closure variables (``entries`` and ``skill_lookup``) so that the one
``tree.add_command`` call at startup owned the only live copy of the
skill list. The closure is never re-entered after startup, so
``/reload-skills`` (which rescans the on-disk skill dir and refreshes
the in-process registry) had no way to propagate its results into the
autocomplete — new skills stayed invisible in the dropdown and deleted
skills returned an "Unknown skill" error when the stale autocomplete
entry was clicked.

The fix promotes those two variables to instance attributes
(``_skill_entries`` / ``_skill_lookup``) and exposes a
``refresh_skill_group()`` method that rescans and mutates them in
place. The gateway ``_handle_reload_skills_command`` resolves the adapter
that received the command and refreshes only that adapter.

No ``tree.sync()`` is required because Discord fetches autocomplete
options dynamically on every keystroke — we only need to rebind the
data the live callbacks already read from.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


def _make_adapter():
    """Construct a DiscordAdapter without going through __init__ / token checks."""
    from plugins.platforms.discord.adapter import DiscordAdapter
    from gateway.platforms.base import Platform
    adapter = object.__new__(DiscordAdapter)
    adapter.config = MagicMock()
    adapter.config.extra = {}
    # ``platform`` is set by BasePlatformAdapter.__init__, which we skip
    # above; the inherited ``.name`` property dereferences it for log
    # formatting, so set it explicitly.
    adapter.platform = Platform.DISCORD
    return adapter


class TestRefreshSkillGroup:
    def test_refresh_repopulates_entries_after_catalog_change(
        self, monkeypatch
    ) -> None:
        """The initial catalog is replaced wholesale on refresh.

        Mirrors the observable /reload-skills case: a user adds a new
        skill to ~/.hermes/skills/, runs /reload-skills, and expects
        the autocomplete to surface it on the very next keystroke.
        """
        adapter = _make_adapter()

        # Start-of-process state: /register built the catalog from the
        # original collector output.
        adapter._skill_entries = [
            ("old-skill", "Pre-existing skill", "/old-skill"),
        ]
        adapter._skill_lookup = {"old-skill": ("Pre-existing skill", "/old-skill")}
        adapter._skill_group_reserved_names = set()
        adapter._skill_group_hidden_count = 0

        # User adds new-skill to disk and removes old-skill.
        def fake_collector(*, reserved_names):
            return (
                {"creative": [("new-skill", "Fresh skill", "/new-skill")]},  # categories
                [],  # uncategorized
                0,   # hidden
            )

        monkeypatch.setattr(
            "hermes_cli.commands.discord_skill_commands_by_category",
            fake_collector,
        )

        new_count, hidden = adapter.refresh_skill_group()

        assert new_count == 1
        assert hidden == 0
        # Old skill is gone, new skill is present.
        names = [n for n, _d, _k in adapter._skill_entries]
        assert names == ["new-skill"]
        assert "old-skill" not in adapter._skill_lookup
        assert adapter._skill_lookup["new-skill"] == ("Fresh skill", "/new-skill")

    def test_refresh_includes_routed_profile_local_skill(self, tmp_path) -> None:
        """Discord categorization follows the active profile's local root."""
        from agent.skill_commands import _reset_skill_commands_cache_for_tests
        from gateway.session_context import clear_session_vars, set_session_vars
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override

        profile = tmp_path / "profile"
        skill_dir = profile / "skills" / "profile-local"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\nname: profile-local\ndescription: Routed profile skill.\n---\nbody\n"
        )
        adapter = _make_adapter()
        adapter._skill_group_reserved_names = set()
        _reset_skill_commands_cache_for_tests()
        home_token = set_hermes_home_override(profile)
        session_tokens = set_session_vars(platform="discord", profile="eve")
        try:
            count, hidden = adapter.refresh_skill_group()
        finally:
            clear_session_vars(session_tokens)
            reset_hermes_home_override(home_token)
            _reset_skill_commands_cache_for_tests()

        assert (count, hidden) == (1, 0)
        assert adapter._skill_lookup == {
            "profile-local": ("Routed profile skill.", "/profile-local")
        }

    def test_shared_adapter_keeps_routed_profile_catalogs_distinct(
        self, monkeypatch
    ) -> None:
        """Refreshing one routed profile never replaces its sibling's picker."""
        adapter = _make_adapter()
        adapter._skill_entries = [("default", "Default skill", "/default")]
        adapter._skill_lookup = {"default": ("Default skill", "/default")}
        adapter._skill_group_hidden_count = 0
        adapter._skill_group_reserved_names = set()
        adapter._skill_catalogs_by_profile = {}
        active_profile = "eve"

        def fake_collector(*, reserved_names):
            name = f"{active_profile}-only"
            return ({"profile": [(name, name, f"/{name}")]}, [], 0)

        monkeypatch.setattr(
            "hermes_cli.commands.discord_skill_commands_by_category",
            fake_collector,
        )
        adapter.refresh_skill_group(profile="eve")
        active_profile = "grace"
        adapter.refresh_skill_group(profile="grace")

        eve_interaction = object()
        grace_interaction = object()

        def fake_event(interaction, _text):
            profile = "eve" if interaction is eve_interaction else "grace"
            return SimpleNamespace(source=SimpleNamespace(profile=profile))

        adapter._build_slash_event = fake_event
        eve_entries, eve_lookup = adapter._skill_catalog_for_interaction(
            eve_interaction
        )
        grace_entries, grace_lookup = adapter._skill_catalog_for_interaction(
            grace_interaction
        )

        assert [entry[0] for entry in eve_entries] == ["eve-only"]
        assert set(eve_lookup) == {"eve-only"}
        assert [entry[0] for entry in grace_entries] == ["grace-only"]
        assert set(grace_lookup) == {"grace-only"}
        assert adapter._skill_lookup == {
            "default": ("Default skill", "/default")
        }

    @pytest.mark.asyncio
    async def test_shared_adapter_lazily_seeds_routed_profile_catalog(
        self, tmp_path
    ) -> None:
        """The first picker use after restart loads only its routed profile."""
        from agent.skill_commands import _reset_skill_commands_cache_for_tests
        from gateway.platforms.base import Platform

        profile_home = tmp_path / "profiles" / "eve"
        skill_dir = profile_home / "skills" / "eve-only"
        skill_dir.mkdir(parents=True)
        (skill_dir / "SKILL.md").write_text(
            "---\nname: eve-only\ndescription: Eve-only skill.\n---\nbody\n"
        )

        adapter = _make_adapter()
        adapter._skill_entries = [("default", "Default skill", "/default")]
        adapter._skill_lookup = {"default": ("Default skill", "/default")}
        adapter._skill_group_hidden_count = 0
        adapter._skill_group_reserved_names = set()
        adapter._skill_catalogs_by_profile = {}
        adapter._evaos_profile_name = ""
        source = SimpleNamespace(profile="eve", platform=Platform.DISCORD)
        adapter._build_slash_event = lambda _interaction, _text: SimpleNamespace(
            source=source
        )
        adapter.gateway_runner = SimpleNamespace(
            _resolve_profile_home_for_source=lambda _source: profile_home
        )

        _reset_skill_commands_cache_for_tests()
        try:
            await adapter._ensure_skill_catalog_for_interaction(object())
            entries, lookup = adapter._skill_catalog_for_interaction(object())
        finally:
            _reset_skill_commands_cache_for_tests()

        assert [entry[0] for entry in entries] == ["eve-only"]
        assert set(lookup) == {"eve-only"}
        assert adapter._skill_lookup == {
            "default": ("Default skill", "/default")
        }

    def test_rejected_route_never_falls_back_to_default_catalog(self) -> None:
        """An explicit unserved route cannot inspect the shared picker."""
        adapter = _make_adapter()
        adapter._skill_entries = [("default", "Default skill", "/default")]
        adapter._skill_lookup = {"default": ("Default skill", "/default")}
        adapter._build_slash_event = lambda _interaction, _text: SimpleNamespace(
            source=SimpleNamespace(
                profile=None,
                profile_route_rejected=True,
            )
        )

        entries, lookup = adapter._skill_catalog_for_interaction(object())

        assert entries == []
        assert lookup == {}


class TestRegisterSkillGroupUsesInstanceState:
    """The closure-based ``entries`` / ``skill_lookup`` must be gone.

    If the callbacks in ``_register_skill_group`` still close over
    local variables instead of reading from ``self``, the refresh
    method is useless — autocomplete will keep serving the stale list.

    The full slash-command registration path pulls in ``discord.app_commands``
    decorators (``@describe`` / ``@autocomplete`` / ``Command``), which
    are unstubbed in the hermetic test env. We assert the data-shaped
    side-effects instead: after ``_register_skill_group`` returns
    (successfully or not), ``_skill_entries`` and ``_skill_lookup`` must
    be populated from the collector output, because
    ``_refresh_skill_catalog_state`` runs before any decorator evaluation.
    """

    def test_refresh_catalog_state_populates_instance_attrs(
        self, monkeypatch
    ) -> None:
        adapter = _make_adapter()
        adapter._skill_group_reserved_names = set()

        def fake_collector(*, reserved_names):
            return (
                {"creative": [("ascii-art", "Make ASCII", "/ascii-art")]},
                [],
                0,
            )
        monkeypatch.setattr(
            "hermes_cli.commands.discord_skill_commands_by_category",
            fake_collector,
        )

        adapter._refresh_skill_catalog_state()

        # Instance-level state populated — the autocomplete + handler
        # callbacks both read from these, so `refresh_skill_group`
        # mutating them in place is enough to pick up new skills.
        assert adapter._skill_entries == [
            ("ascii-art", "Make ASCII", "/ascii-art"),
        ]
        assert adapter._skill_lookup == {
            "ascii-art": ("Make ASCII", "/ascii-art"),
        }
        assert adapter._skill_group_hidden_count == 0


class TestHandleReloadSkillsCallsRefreshSkillGroup:
    """Gateway-side integration: /reload-skills must call refresh on adapters."""

    @pytest.mark.asyncio
    async def test_refreshes_only_routed_secondary_adapter_with_context(self, tmp_path):
        """The worker keeps profile context and refreshes only its adapter."""
        from unittest.mock import patch

        from gateway.run import GatewayRunner
        from gateway.platforms.base import Platform
        from gateway.session import SessionSource
        from gateway.session_context import (
            clear_session_vars,
            get_session_env,
            set_session_vars,
        )
        from hermes_constants import (
            get_hermes_home,
            reset_hermes_home_override,
            set_hermes_home_override,
        )

        runner = object.__new__(GatewayRunner)
        runner.config = MagicMock(multiplex_profiles=True)
        default_adapter = MagicMock(name="default-discord")
        eve_adapter = MagicMock(name="eve-discord")
        runner.adapters = {Platform.DISCORD: default_adapter}
        runner._profile_adapters = {"eve": {Platform.DISCORD: eve_adapter}}
        runner._active_profile_name = lambda: "default"
        runner._session_key_for_source = lambda src: None
        runner._pending_skills_reload_notes = {}

        source = SessionSource(
            platform=Platform.DISCORD,
            user_id="owner",
            chat_id="eve-channel",
            chat_type="group",
            profile="eve",
        )
        event = MagicMock(source=source)
        observed = {}

        fake_result = {"added": [], "removed": [], "total": 7}
        def fake_reload():
            from agent.skill_commands import get_skill_commands
            observed["home"] = str(get_hermes_home())
            observed["platform"] = get_session_env("HERMES_SESSION_PLATFORM")
            observed["catalog"] = set(get_skill_commands())
            return fake_result

        profile_home = tmp_path / "profiles" / "eve"
        runner._resolve_profile_home_for_source = lambda src: profile_home

        def refresh_profile_catalog(*, profile):
            observed["refresh_profile"] = profile
            observed["refresh_home"] = str(get_hermes_home())
            observed["refresh_platform"] = get_session_env(
                "HERMES_SESSION_PLATFORM"
            )
            return (3, 0)

        eve_adapter.refresh_skill_group.side_effect = refresh_profile_catalog
        for name in ("discord-only", "telegram-only"):
            skill_dir = profile_home / "skills" / name
            skill_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text(
                f"---\nname: {name}\ndescription: {name}.\n---\nbody\n"
            )
        from agent.skill_commands import _reset_skill_commands_cache_for_tests
        from tools import skills_tool

        def disabled_for_route():
            return {f"{get_session_env('HERMES_SESSION_PLATFORM')}-only"}

        _reset_skill_commands_cache_for_tests()
        home_token = set_hermes_home_override(profile_home)
        outer_tokens = set_session_vars(platform="outer", profile="outer")
        with (
            patch("agent.skill_commands.reload_skills", side_effect=fake_reload),
            patch.object(
                skills_tool,
                "_get_disabled_skill_names",
                side_effect=disabled_for_route,
            ),
        ):
            try:
                result = await runner._handle_reload_skills_command(event)
                observed["restored_platform"] = get_session_env(
                    "HERMES_SESSION_PLATFORM"
                )
            finally:
                clear_session_vars(outer_tokens)
                reset_hermes_home_override(home_token)
                _reset_skill_commands_cache_for_tests()
                runner._executor.shutdown(wait=True)

        assert "Skills Reloaded" in result
        assert observed["home"] == str(profile_home)
        assert observed["platform"] == "discord"
        assert observed["catalog"] == {"/telegram-only"}
        assert observed["refresh_home"] == str(profile_home)
        assert observed["refresh_platform"] == "discord"
        assert observed["refresh_profile"] == "eve"
        assert observed["restored_platform"] == "outer"
        eve_adapter.refresh_skill_group.assert_called_once_with(profile="eve")
        default_adapter.refresh_skill_group.assert_not_called()

    @pytest.mark.asyncio
    async def test_missing_secondary_adapter_fails_without_primary_refresh(self):
        """A stamped secondary route never falls back to the primary adapter."""
        from unittest.mock import patch

        from gateway.run import GatewayRunner
        from gateway.platforms.base import Platform
        from gateway.session import SessionSource

        runner = object.__new__(GatewayRunner)
        default_adapter = MagicMock(name="default-discord")
        runner.adapters = {Platform.DISCORD: default_adapter}
        runner._profile_adapters = {}
        runner._active_profile_name = lambda: "default"
        runner._session_key_for_source = lambda src: None
        runner._pending_skills_reload_notes = {}
        event = MagicMock(
            source=SessionSource(
                platform=Platform.DISCORD,
                user_id="owner",
                chat_id="missing-channel",
                chat_type="group",
                profile="missing-secondary",
            )
        )

        with patch(
            "agent.skill_commands.reload_skills",
            return_value={"added": [], "removed": [], "total": 1},
        ):
            try:
                result = await runner._handle_reload_skills_command(event)
            finally:
                runner._executor.shutdown(wait=True)

        assert "routed adapter unavailable" in result
        default_adapter.refresh_skill_group.assert_not_called()
