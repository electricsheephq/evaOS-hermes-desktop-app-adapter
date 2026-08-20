import asyncio
import os
from types import SimpleNamespace

import pytest

from gateway.config import Platform
from gateway.run import GatewayRunner
from gateway.run import _profile_runtime_scope
from gateway.session import SessionContext, SessionSource
from gateway.session_context import (
    get_session_env,
    set_session_vars,
    clear_session_vars,
    reset_session_vars,
    _VAR_MAP,
    _UNSET,
)


@pytest.fixture(autouse=True)
def _reset_contextvars():
    """Reset all session contextvars to _UNSET between tests.

    In production each asyncio.Task gets a fresh context copy where the
    defaults are _UNSET.  In tests all functions share the same thread
    context, so a clear_session_vars() from test A (which sets vars to "")
    would leak into test B.  This fixture ensures each test starts clean.
    """
    yield
    for var in _VAR_MAP.values():
        # Can't use var.reset() without a token; just set back to sentinel.
        var.set(_UNSET)


def test_set_session_env_sets_contextvars(monkeypatch):
    """_set_session_env should populate contextvars, not os.environ."""
    runner = object.__new__(GatewayRunner)
    source = SessionSource(
        platform=Platform.TELEGRAM,
        chat_id="-1001",
        chat_name="Group",
        chat_type="group",
        user_id="123456",
        user_name="alice",
        thread_id="17585",
    )
    context = SessionContext(source=source, connected_platforms=[], home_channels={})

    monkeypatch.delenv("HERMES_SESSION_PLATFORM", raising=False)
    monkeypatch.delenv("HERMES_SESSION_SOURCE", raising=False)
    monkeypatch.delenv("HERMES_SESSION_CHAT_ID", raising=False)
    monkeypatch.delenv("HERMES_SESSION_CHAT_NAME", raising=False)
    monkeypatch.delenv("HERMES_SESSION_CHAT_TYPE", raising=False)
    monkeypatch.delenv("HERMES_SESSION_USER_ID", raising=False)
    monkeypatch.delenv("HERMES_SESSION_USER_NAME", raising=False)
    monkeypatch.delenv("HERMES_SESSION_THREAD_ID", raising=False)

    tokens = runner._set_session_env(context)

    # Values should be readable via get_session_env (contextvar path)
    assert get_session_env("HERMES_SESSION_PLATFORM") == "telegram"
    assert get_session_env("HERMES_SESSION_SOURCE") == ""
    assert get_session_env("HERMES_SESSION_CHAT_ID") == "-1001"
    assert get_session_env("HERMES_SESSION_CHAT_NAME") == "Group"
    assert get_session_env("HERMES_SESSION_CHAT_TYPE") == "group"
    assert get_session_env("HERMES_SESSION_USER_ID") == "123456"
    assert get_session_env("HERMES_SESSION_USER_NAME") == "alice"
    assert get_session_env("HERMES_SESSION_THREAD_ID") == "17585"

    # os.environ should NOT be touched
    assert os.getenv("HERMES_SESSION_PLATFORM") is None
    assert os.getenv("HERMES_SESSION_SOURCE") is None
    assert os.getenv("HERMES_SESSION_CHAT_TYPE") is None
    assert os.getenv("HERMES_SESSION_THREAD_ID") is None

    # Clean up
    runner._clear_session_env(tokens)


def test_multiplex_session_env_pins_routed_profile_cwd(monkeypatch, tmp_path):
    """Concurrent profiles must not discover one another's AGENTS workspace."""
    from agent.runtime_cwd import resolve_context_cwd
    from agent.prompt_builder import build_context_files_prompt

    monkeypatch.setenv("TERMINAL_CWD", str(tmp_path / "stale-default"))
    runner = object.__new__(GatewayRunner)
    runner.config = SimpleNamespace(multiplex_profiles=True)
    runner.adapters = {}

    homes = []
    for profile in ("eve", "grace"):
        home = tmp_path / profile / "home"
        workspace = tmp_path / profile / "workspace"
        home.mkdir(parents=True)
        workspace.mkdir(parents=True)
        (workspace / "AGENTS.md").write_text(
            f"# {profile} operating manual\n", encoding="utf-8"
        )
        (home / "config.yaml").write_text(
            f"terminal:\n  cwd: {workspace}\n", encoding="utf-8"
        )
        homes.append((profile, home, workspace))

    async def bind(profile, home, workspace):
        source = SessionSource(
            platform=Platform.DISCORD,
            chat_id=profile,
            chat_type="channel",
            user_id=f"{profile}-user",
            profile=profile,
        )
        context = SessionContext(source=source, connected_platforms=[], home_channels={})
        with _profile_runtime_scope(home):
            tokens = runner._set_session_env(context)
            try:
                await asyncio.sleep(0)
                cwd = resolve_context_cwd()
                return (
                    cwd,
                    get_session_env("HERMES_SESSION_PROFILE"),
                    build_context_files_prompt(cwd=cwd, skip_soul=True),
                )
            finally:
                runner._clear_session_env(tokens)

    async def run():
        return await asyncio.gather(*(bind(*item) for item in homes))

    assert asyncio.run(run()) == [
        (
            homes[0][2],
            "eve",
            "# Project Context\n\nThe following project context files have "
            "been loaded and should be followed:\n\n## AGENTS.md\n\n"
            "# eve operating manual",
        ),
        (
            homes[1][2],
            "grace",
            "# Project Context\n\nThe following project context files have "
            "been loaded and should be followed:\n\n## AGENTS.md\n\n"
            "# grace operating manual",
        ),
    ]


def test_multiplex_profile_without_config_masks_process_default_cwd(monkeypatch, tmp_path):
    """A fresh routed profile must not inherit the launch profile workspace."""
    from agent.runtime_cwd import resolve_context_cwd
    from agent.prompt_builder import build_context_files_prompt

    stale = tmp_path / "default-workspace"
    stale.mkdir()
    (stale / "AGENTS.md").write_text("# wrong default profile\n", encoding="utf-8")
    monkeypatch.setenv("TERMINAL_CWD", str(stale))
    runner = object.__new__(GatewayRunner)
    runner.config = SimpleNamespace(multiplex_profiles=True)
    runner.adapters = {}
    home = tmp_path / "fresh-profile" / "home"
    home.mkdir(parents=True)
    source = SessionSource(
        platform=Platform.DISCORD,
        chat_id="fresh",
        chat_type="channel",
        user_id="fresh-user",
        profile="fresh",
    )
    context = SessionContext(source=source, connected_platforms=[], home_channels={})

    with _profile_runtime_scope(home):
        tokens = runner._set_session_env(context)
        try:
            assert resolve_context_cwd() is None
            assert "wrong default profile" not in build_context_files_prompt(
                cwd=resolve_context_cwd(), skip_soul=True
            )
        finally:
            runner._clear_session_env(tokens)


def test_multiplex_session_resolves_terminal_config_once(monkeypatch, tmp_path):
    """The routed scope loads config; _set_session_env must not load it again."""
    import gateway.run as gateway_run
    import hermes_cli.config as hermes_config

    home = tmp_path / "profile" / "home"
    workspace = tmp_path / "profile" / "workspace"
    home.mkdir(parents=True)
    workspace.mkdir(parents=True)
    (home / "config.yaml").write_text(
        f"terminal:\n  cwd: {workspace}\n", encoding="utf-8"
    )

    resolution_calls = 0
    original_resolver = gateway_run._load_profile_terminal_config

    def counted_resolver():
        nonlocal resolution_calls
        resolution_calls += 1
        return original_resolver()

    def reject_second_loader(*args, **kwargs):
        raise AssertionError("_set_session_env must use the active terminal scope")

    monkeypatch.setattr(gateway_run, "_load_profile_terminal_config", counted_resolver)
    monkeypatch.setattr(hermes_config, "load_config_readonly", reject_second_loader)

    runner = object.__new__(GatewayRunner)
    runner.config = SimpleNamespace(multiplex_profiles=True)
    runner.adapters = {}
    context = SessionContext(
        source=SessionSource(
            platform=Platform.DISCORD,
            chat_id="profile",
            chat_type="channel",
            user_id="profile-user",
            profile="profile",
        ),
        connected_platforms=[],
        home_channels={},
    )

    with _profile_runtime_scope(home):
        assert resolution_calls == 1
        tokens = runner._set_session_env(context)
        runner._clear_session_env(tokens)
        assert resolution_calls == 1

    assert resolution_calls == 1


def test_multiplex_profile_without_cwd_isolated_from_configured_sibling(monkeypatch, tmp_path):
    """An empty routed profile must not inherit its configured sibling's context."""
    from agent.prompt_builder import build_context_files_prompt
    from agent.runtime_cwd import resolve_context_cwd

    configured_home = tmp_path / "configured" / "home"
    configured_workspace = tmp_path / "configured" / "workspace"
    empty_home = tmp_path / "empty" / "home"
    configured_home.mkdir(parents=True)
    configured_workspace.mkdir(parents=True)
    empty_home.mkdir(parents=True)
    (configured_workspace / "AGENTS.md").write_text(
        "# configured profile only\n", encoding="utf-8"
    )
    (configured_home / "config.yaml").write_text(
        f"terminal:\n  cwd: {configured_workspace}\n", encoding="utf-8"
    )
    monkeypatch.setenv("TERMINAL_CWD", str(configured_workspace))

    runner = object.__new__(GatewayRunner)
    runner.config = SimpleNamespace(multiplex_profiles=True)
    runner.adapters = {}

    async def bind(profile, home):
        context = SessionContext(
            source=SessionSource(
                platform=Platform.DISCORD,
                chat_id=profile,
                chat_type="channel",
                user_id=f"{profile}-user",
                profile=profile,
            ),
            connected_platforms=[],
            home_channels={},
        )
        with _profile_runtime_scope(home):
            tokens = runner._set_session_env(context)
            try:
                await asyncio.sleep(0)
                cwd = resolve_context_cwd()
                return cwd, build_context_files_prompt(cwd=cwd, skip_soul=True)
            finally:
                runner._clear_session_env(tokens)

    async def run():
        return await asyncio.gather(
            bind("configured", configured_home),
            bind("empty", empty_home),
        )

    configured, empty = asyncio.run(run())
    assert configured[0] == configured_workspace
    assert "configured profile only" in configured[1]
    assert empty == (None, "")


def test_single_profile_session_cwd_remains_unpinned(monkeypatch, tmp_path):
    """Single-profile gateways keep cwd='' and process-setting fallback."""
    import gateway.session_context as session_context
    from agent.runtime_cwd import resolve_context_cwd

    monkeypatch.setenv("TERMINAL_CWD", str(tmp_path))
    captured = {}
    original_set_session_vars = session_context.set_session_vars

    def capture_set_session_vars(**kwargs):
        captured["cwd"] = kwargs.get("cwd")
        return original_set_session_vars(**kwargs)

    monkeypatch.setattr(session_context, "set_session_vars", capture_set_session_vars)
    runner = object.__new__(GatewayRunner)
    runner.config = SimpleNamespace(multiplex_profiles=False)
    runner.adapters = {}
    context = SessionContext(
        source=SessionSource(
            platform=Platform.DISCORD,
            chat_id="single",
            chat_type="channel",
            user_id="single-user",
        ),
        connected_platforms=[],
        home_channels={},
    )

    tokens = runner._set_session_env(context)
    try:
        assert captured["cwd"] == ""
        assert resolve_context_cwd() == tmp_path
    finally:
        runner._clear_session_env(tokens)


def test_clear_session_env_restores_previous_state(monkeypatch):
    """_clear_session_env should restore contextvars to their pre-handler values."""
    runner = object.__new__(GatewayRunner)

    monkeypatch.delenv("HERMES_SESSION_PLATFORM", raising=False)
    monkeypatch.delenv("HERMES_SESSION_CHAT_ID", raising=False)
    monkeypatch.delenv("HERMES_SESSION_CHAT_NAME", raising=False)
    monkeypatch.delenv("HERMES_SESSION_CHAT_TYPE", raising=False)
    monkeypatch.delenv("HERMES_SESSION_USER_ID", raising=False)
    monkeypatch.delenv("HERMES_SESSION_USER_NAME", raising=False)
    monkeypatch.delenv("HERMES_SESSION_THREAD_ID", raising=False)

    source = SessionSource(
        platform=Platform.TELEGRAM,
        chat_id="-1001",
        chat_name="Group",
        chat_type="group",
        user_id="123456",
        user_name="alice",
        thread_id="17585",
    )
    context = SessionContext(source=source, connected_platforms=[], home_channels={})

    tokens = runner._set_session_env(context)
    assert get_session_env("HERMES_SESSION_PLATFORM") == "telegram"
    assert get_session_env("HERMES_SESSION_USER_ID") == "123456"
    assert get_session_env("HERMES_SESSION_CHAT_TYPE") == "group"

    runner._clear_session_env(tokens)

    # After clear, contextvars should return to defaults (empty)
    assert get_session_env("HERMES_SESSION_PLATFORM") == ""
    assert get_session_env("HERMES_SESSION_CHAT_ID") == ""
    assert get_session_env("HERMES_SESSION_CHAT_NAME") == ""
    assert get_session_env("HERMES_SESSION_CHAT_TYPE") == ""
    assert get_session_env("HERMES_SESSION_USER_ID") == ""
    assert get_session_env("HERMES_SESSION_USER_NAME") == ""
    assert get_session_env("HERMES_SESSION_THREAD_ID") == ""


def test_get_session_env_falls_back_to_os_environ(monkeypatch):
    """get_session_env should fall back to os.environ when contextvar is unset."""
    monkeypatch.setenv("HERMES_SESSION_PLATFORM", "discord")

    # No contextvar set — should read from os.environ
    assert get_session_env("HERMES_SESSION_PLATFORM") == "discord"

    # Now set a contextvar — should prefer it
    tokens = set_session_vars(platform="telegram")
    assert get_session_env("HERMES_SESSION_PLATFORM") == "telegram"

    # After clear — should return "" (explicitly cleared), NOT fall back
    # to os.environ.  This is the fix for #10304: stale os.environ values
    # must not leak through after a gateway session is cleaned up.
    clear_session_vars(tokens)
    assert get_session_env("HERMES_SESSION_PLATFORM") == ""


# ---------------------------------------------------------------------------
# SESSION_KEY contextvars tests
# ---------------------------------------------------------------------------


def test_session_key_falls_back_to_os_environ(monkeypatch):
    """get_session_env for SESSION_KEY should fall back to os.environ."""
    monkeypatch.setenv("HERMES_SESSION_KEY", "env-session-123")

    # No contextvar set — should read from os.environ
    assert get_session_env("HERMES_SESSION_KEY") == "env-session-123"

    # Set contextvar — should prefer it
    tokens = set_session_vars(session_key="ctx-session-456")
    assert get_session_env("HERMES_SESSION_KEY") == "ctx-session-456"

    # After clear — should return "" (explicitly cleared), not os.environ (#10304)
    clear_session_vars(tokens)
    assert get_session_env("HERMES_SESSION_KEY") == ""


def test_session_key_no_race_condition_with_contextvars(monkeypatch):
    """Prove contextvars isolates SESSION_KEY across concurrent async tasks.

    Two tasks set different session keys. With contextvars each task
    reads back its own value. With os.environ the second task would
    overwrite the first (the old bug).
    """
    monkeypatch.delenv("HERMES_SESSION_KEY", raising=False)

    results = {}

    async def handler(key: str, delay: float):
        tokens = set_session_vars(session_key=key)
        try:
            await asyncio.sleep(delay)
            read_back = get_session_env("HERMES_SESSION_KEY")
            results[key] = read_back
        finally:
            clear_session_vars(tokens)

    async def run():
        task_a = asyncio.create_task(handler("session-A", 0.15))
        await asyncio.sleep(0.05)
        task_b = asyncio.create_task(handler("session-B", 0.05))
        await asyncio.gather(task_a, task_b)

    asyncio.run(run())

    # Both tasks must read back their own session key
    assert results["session-A"] == "session-A", (
        f"Session A got '{results['session-A']}' instead of 'session-A' — race condition!"
    )
    assert results["session-B"] == "session-B", (
        f"Session B got '{results['session-B']}' instead of 'session-B' — race condition!"
    )


@pytest.mark.asyncio
async def test_run_in_executor_with_context_preserves_session_env(monkeypatch):
    """Gateway executor work should inherit session contextvars for tool routing."""
    runner = object.__new__(GatewayRunner)
    monkeypatch.delenv("HERMES_SESSION_PLATFORM", raising=False)
    monkeypatch.delenv("HERMES_SESSION_CHAT_ID", raising=False)
    monkeypatch.delenv("HERMES_SESSION_THREAD_ID", raising=False)
    monkeypatch.delenv("HERMES_SESSION_USER_ID", raising=False)

    source = SessionSource(
        platform=Platform.TELEGRAM,
        chat_id="2144471399",
        chat_type="dm",
        user_id="123456",
        user_name="alice",
        thread_id=None,
    )
    context = SessionContext(
        source=source,
        connected_platforms=[],
        home_channels={},
        session_key="agent:main:telegram:dm:2144471399",
    )

    tokens = runner._set_session_env(context)
    try:
        result = await runner._run_in_executor_with_context(
            lambda: {
                "platform": get_session_env("HERMES_SESSION_PLATFORM"),
                "chat_id": get_session_env("HERMES_SESSION_CHAT_ID"),
                "user_id": get_session_env("HERMES_SESSION_USER_ID"),
                "session_key": get_session_env("HERMES_SESSION_KEY"),
            }
        )
    finally:
        runner._clear_session_env(tokens)
        runner._shutdown_executor()

    assert result == {
        "platform": "telegram",
        "chat_id": "2144471399",
        "user_id": "123456",
        "session_key": "agent:main:telegram:dm:2144471399",
    }




def test_cron_session_contextvar_preserves_legacy_env_fallback(monkeypatch):
    """Unset cron ContextVar keeps old env-only cron callers working."""
    monkeypatch.setenv("HERMES_CRON_SESSION", "1")

    assert get_session_env("HERMES_CRON_SESSION") == "1"


def test_cron_session_explicit_blank_masks_leaked_env(monkeypatch):
    """Non-cron session bindings must override a stale process cron env flag."""
    monkeypatch.setenv("HERMES_CRON_SESSION", "1")

    tokens = set_session_vars(platform="api_server", cron_session="")
    try:
        assert get_session_env("HERMES_CRON_SESSION") == ""
    finally:
        clear_session_vars(tokens)

    assert get_session_env("HERMES_CRON_SESSION") == ""


def test_cron_session_set_clear_and_reset_tristate(monkeypatch):
    """Cron marker supports _UNSET fallback, 1 cron, and  explicit clear."""
    monkeypatch.setenv("HERMES_CRON_SESSION", "1")

    tokens = set_session_vars(cron_session="1")
    assert get_session_env("HERMES_CRON_SESSION") == "1"

    clear_session_vars(tokens)
    assert get_session_env("HERMES_CRON_SESSION") == ""

    reset_session_vars()
    assert get_session_env("HERMES_CRON_SESSION") == "1"
