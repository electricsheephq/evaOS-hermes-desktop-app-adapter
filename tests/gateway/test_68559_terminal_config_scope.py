"""Regression tests for routed-profile terminal configuration scope (#68559)."""

import json
import os
from concurrent.futures import ThreadPoolExecutor
from contextvars import copy_context
from pathlib import Path
from unittest import mock

import pytest


_TERMINAL_ENV_PREFIX = "TERMINAL_"


@pytest.fixture(autouse=True)
def _reset_terminal_scope_and_environment():
    from tools import terminal_tool

    original_env = {
        key: value
        for key, value in os.environ.items()
        if key.startswith(_TERMINAL_ENV_PREFIX)
    }
    for key in list(original_env):
        os.environ.pop(key, None)
    bridge_attempted = terminal_tool._terminal_config_bridge_attempted
    terminal_tool._terminal_config_bridge_attempted = False
    scope_setter = getattr(terminal_tool, "set_terminal_config_scope", None)
    token = scope_setter(None) if scope_setter is not None else None
    try:
        yield
    finally:
        if token is not None:
            terminal_tool.reset_terminal_config_scope(token)
        terminal_tool._terminal_config_bridge_attempted = bridge_attempted
        for key in list(os.environ):
            if key.startswith(_TERMINAL_ENV_PREFIX):
                os.environ.pop(key, None)
        os.environ.update(original_env)


def _write_profile(home: Path, terminal: dict | None = None) -> None:
    home.mkdir()
    config = {} if terminal is None else {"terminal": terminal}
    (home / "config.yaml").write_text(json.dumps(config), encoding="utf-8")


def _gateway_and_routed_homes(tmp_path, gateway_terminal, routed_terminal=None):
    gateway_home = tmp_path / "gateway"
    routed_home = tmp_path / "routed"
    _write_profile(gateway_home, gateway_terminal)
    _write_profile(routed_home, routed_terminal)
    return gateway_home, routed_home


def _seed_gateway_terminal_config(monkeypatch, gateway_home):
    from tools import terminal_tool

    monkeypatch.setenv("HERMES_HOME", str(gateway_home))
    gateway_config = terminal_tool._get_env_config()
    assert terminal_tool._terminal_config_bridge_attempted is True
    return gateway_config


def test_routed_profile_uses_its_terminal_backend(tmp_path, monkeypatch):
    """A routed docker profile must not inherit the gateway's local backend."""
    from gateway.run import _profile_runtime_scope
    from tools import terminal_tool

    gateway_home, routed_home = _gateway_and_routed_homes(
        tmp_path,
        {"backend": "local"},
        {"backend": "docker", "docker_image": "routed-image"},
    )
    gateway_config = _seed_gateway_terminal_config(monkeypatch, gateway_home)
    assert gateway_config["env_type"] == "local"

    with _profile_runtime_scope(routed_home):
        routed_config = terminal_tool._get_env_config()

    assert routed_config["env_type"] == "docker"
    assert routed_config["docker_image"] == "routed-image"


def test_gateway_terminal_config_is_restored_after_scope(tmp_path, monkeypatch):
    from gateway.run import _profile_runtime_scope
    from tools import terminal_tool

    gateway_home, routed_home = _gateway_and_routed_homes(
        tmp_path,
        {"backend": "local"},
        {"backend": "docker"},
    )
    before = _seed_gateway_terminal_config(monkeypatch, gateway_home)

    with _profile_runtime_scope(routed_home):
        assert terminal_tool._get_env_config()["env_type"] == "docker"

    assert terminal_tool._get_env_config() == before


def test_routed_local_profile_does_not_inherit_docker_settings(tmp_path, monkeypatch):
    from gateway.run import _profile_runtime_scope
    from tools import terminal_tool

    gateway_home, routed_home = _gateway_and_routed_homes(
        tmp_path,
        {
            "backend": "docker",
            "docker_image": "gateway-image",
            "docker_volumes": ["/host:/container"],
            "docker_network": False,
        },
        {"backend": "local"},
    )
    gateway_config = _seed_gateway_terminal_config(monkeypatch, gateway_home)
    assert gateway_config["env_type"] == "docker"
    assert gateway_config["docker_image"] == "gateway-image"

    with _profile_runtime_scope(routed_home):
        routed_config = terminal_tool._get_env_config()

    assert routed_config["env_type"] == "local"
    assert routed_config["docker_image"] != "gateway-image"
    assert routed_config["docker_volumes"] == []
    assert routed_config["docker_network"] is True


def test_routed_profiles_do_not_share_cached_terminal_environment(tmp_path, monkeypatch):
    """Multiplexed profiles with different backends need distinct cache entries."""
    from agent.secret_scope import is_multiplex_active, set_multiplex_active
    from gateway.run import _profile_runtime_scope
    from tools import file_tools, terminal_tool

    local_home, docker_home = _gateway_and_routed_homes(
        tmp_path,
        {"backend": "local"},
        {"backend": "docker", "docker_image": "routed-image"},
    )
    created = []

    class _FakeEnvironment:
        def __init__(self, env_type):
            self.env_type = env_type
            self.cwd = str(tmp_path)

        def execute(self, *args, **kwargs):
            return {"output": self.env_type, "exit_code": 0}

    def _fake_create_environment(env_type, *args, **kwargs):
        created.append(env_type)
        return _FakeEnvironment(env_type)

    monkeypatch.setattr(terminal_tool, "_active_environments", {})
    monkeypatch.setattr(terminal_tool, "_last_activity", {})
    monkeypatch.setattr(terminal_tool, "_creation_locks", {})
    monkeypatch.setattr(file_tools, "_file_ops_cache", {})
    monkeypatch.setattr(terminal_tool, "_start_cleanup_thread", lambda: None)
    monkeypatch.setattr(
        terminal_tool,
        "_check_all_guards",
        lambda *args, **kwargs: {"approved": True},
    )
    monkeypatch.setattr(
        terminal_tool,
        "_create_environment",
        _fake_create_environment,
    )

    was_multiplexing = is_multiplex_active()
    set_multiplex_active(True)
    try:
        with _profile_runtime_scope(local_home):
            local_result = json.loads(terminal_tool.terminal_tool("pwd"))
            local_file_ops = file_tools._get_file_ops()
        with _profile_runtime_scope(docker_home):
            docker_result = json.loads(terminal_tool.terminal_tool("pwd"))
            docker_file_ops = file_tools._get_file_ops()
    finally:
        set_multiplex_active(was_multiplexing)

    assert created == ["local", "docker"]
    assert local_result["output"] == "local"
    assert docker_result["output"] == "docker"
    assert local_file_ops.env.env_type == "local"
    assert docker_file_ops.env.env_type == "docker"
    assert len(terminal_tool._active_environments) == 2
    assert len(file_tools._file_ops_cache) == 2


def test_single_profile_path_still_uses_process_environment(tmp_path, monkeypatch):
    from tools import terminal_tool

    home = tmp_path / "single"
    _write_profile(home)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("TERMINAL_ENV", "local")
    monkeypatch.setenv("TERMINAL_TIMEOUT", "37")
    monkeypatch.setenv("TERMINAL_CWD", str(tmp_path))

    with mock.patch.object(
        terminal_tool,
        "_ensure_terminal_env_bridged",
        wraps=terminal_tool._ensure_terminal_env_bridged,
    ) as bridge:
        config = terminal_tool._get_env_config()

    # The bridge is driven by get_terminal_setting() rather than by a single
    # call at the top of _get_env_config, so every read on the unscoped path
    # goes through it. It is a one-shot latch, so the count is not the
    # contract — that it runs at all on this path is.
    assert bridge.called
    assert bridge.call_args_list == [mock.call()] * bridge.call_count
    assert config["env_type"] == "local"
    assert config["timeout"] == 37
    assert config["cwd"] == str(tmp_path)


def test_routed_profile_path_never_bridges_into_process_environment(
    tmp_path, monkeypatch
):
    """The scoped path must not run the process-global config→env bridge.

    Bridging writes one profile's ``terminal.*`` into ``os.environ``, which is
    the exact mechanism #68559 is about: whichever profile trips the latch
    first defines the backend every later profile inherits.
    """
    from gateway.run import _profile_runtime_scope
    from tools import terminal_tool

    gateway_home, routed_home = _gateway_and_routed_homes(
        tmp_path,
        {"backend": "local"},
        {"backend": "docker", "docker_image": "routed-image"},
    )
    _seed_gateway_terminal_config(monkeypatch, gateway_home)

    with mock.patch.object(
        terminal_tool, "_ensure_terminal_env_bridged"
    ) as bridge:
        with _profile_runtime_scope(routed_home):
            config = terminal_tool._get_env_config()

    bridge.assert_not_called()
    assert config["env_type"] == "docker"


def test_terminal_scope_propagates_through_copy_context(tmp_path):
    from tools import terminal_tool

    scope = {
        "TERMINAL_ENV": "docker",
        "TERMINAL_DOCKER_IMAGE": "thread-image",
    }
    token = terminal_tool.set_terminal_config_scope(scope)
    try:
        context = copy_context()
        with mock.patch.object(
            terminal_tool,
            "_ensure_terminal_env_bridged",
            side_effect=AssertionError("active terminal scope used the global bridge"),
        ):
            with ThreadPoolExecutor(max_workers=1) as executor:
                config = executor.submit(context.run, terminal_tool._get_env_config).result()
    finally:
        terminal_tool.reset_terminal_config_scope(token)

    assert config["env_type"] == "docker"
    assert config["docker_image"] == "thread-image"


def test_missing_terminal_section_masks_gateway_defaults(tmp_path, monkeypatch):
    from gateway.run import _profile_runtime_scope
    from tools import terminal_tool

    gateway_home, routed_home = _gateway_and_routed_homes(
        tmp_path,
        {"backend": "local"},
        None,
    )
    gateway_config = _seed_gateway_terminal_config(monkeypatch, gateway_home)

    with _profile_runtime_scope(routed_home):
        with mock.patch.object(
            terminal_tool,
            "_ensure_terminal_env_bridged",
            side_effect=AssertionError("empty profile scope used the global bridge"),
        ):
            routed_config = terminal_tool._get_env_config()

    assert gateway_config["vercel_runtime"] == "node24"
    assert routed_config["vercel_runtime"] == ""
    assert routed_config != gateway_config


def test_profile_terminal_mapping_is_precedence_neutral_for_empty_target(monkeypatch):
    """Explicit and merged backend precedence agree when the target starts empty."""
    from gateway.run import _load_profile_terminal_config
    from hermes_cli import config as config_module

    terminal = {
        "backend": "docker",
        "degraded_mode": True,
        "docker_image": "profile-image",
    }
    monkeypatch.setattr(
        config_module,
        "read_raw_config",
        lambda: {"terminal": dict(terminal)},
    )
    explicit = _load_profile_terminal_config()

    monkeypatch.setattr(
        config_module,
        "read_raw_config",
        lambda: {"terminal": {"degraded_mode": True, "docker_image": "profile-image"}},
    )
    monkeypatch.setattr(
        config_module,
        "load_config_readonly",
        lambda: {"terminal": dict(terminal)},
    )
    merged = config_module.apply_terminal_config_to_env(
        env={}, config=None, override=True
    )

    assert explicit == merged
    assert explicit == {
        "TERMINAL_ENV": "docker",
        "TERMINAL_DEGRADED_MODE": "True",
        "TERMINAL_DOCKER_IMAGE": "profile-image",
    }


def test_profile_ssh_tilde_cwd_remains_remote_unexpanded(monkeypatch):
    from gateway.run import _load_profile_terminal_config
    from hermes_cli import config as config_module

    monkeypatch.setattr(
        config_module,
        "read_raw_config",
        lambda: {"terminal": {"backend": "ssh", "cwd": "~"}},
    )

    assert _load_profile_terminal_config() == {
        "TERMINAL_ENV": "ssh",
        "TERMINAL_CWD": "~",
    }


def test_routed_helpers_ignore_conflicting_process_terminal_settings(monkeypatch, tmp_path):
    from agent.runtime_cwd import resolve_agent_cwd
    from gateway.platforms.base import _parse_docker_volume_mounts
    from tools.file_tools import _configured_terminal_cwd, _terminal_env_type_for_task
    from tools.image_generation_tool import _agent_cache_base_for_env
    from tools.image_source import _is_local_terminal_backend
    from tools.skills_tool import _get_terminal_backend_name
    from tools.terminal_tool import reset_terminal_config_scope, set_terminal_config_scope
    from tools.vision_tools import _terminal_backend_is_local

    process_cwd = tmp_path / "process"
    routed_cwd = tmp_path / "routed"
    process_cwd.mkdir()
    routed_cwd.mkdir()
    monkeypatch.setenv("TERMINAL_ENV", "local")
    monkeypatch.setenv("TERMINAL_CWD", str(process_cwd))

    scope = {
        "TERMINAL_ENV": "docker",
        "TERMINAL_CWD": str(routed_cwd),
        "TERMINAL_DOCKER_VOLUMES": '["/host:/container:ro"]',
    }
    token = set_terminal_config_scope(scope)
    try:
        assert resolve_agent_cwd() == routed_cwd
        assert _configured_terminal_cwd() == str(routed_cwd)
        assert _terminal_env_type_for_task() == "docker"
        assert _agent_cache_base_for_env(None) == "/root/.hermes"
        assert _get_terminal_backend_name() == "docker"
        assert not _is_local_terminal_backend()
        assert not _terminal_backend_is_local()
        assert [(str(host), str(container)) for host, container in _parse_docker_volume_mounts()] == [
            ("/host", "/container")
        ]
    finally:
        reset_terminal_config_scope(token)


# --- Guard: no module may reintroduce a process-global TERMINAL_* read -------
#
# Every fix above is a conversion of one direct ``os.environ`` read into
# ``get_terminal_setting``.  Nothing structural stops a later change from
# adding a fresh ``os.getenv("TERMINAL_...")`` next to the converted ones and
# silently reopening the cross-profile leak — the resulting bug is invisible
# in a single-profile test run, which is how the original holes survived.
# This test greps the AST rather than the text so comments and docstrings that
# merely mention the env vars don't register as reads.

# Modules that must resolve terminal settings through the accessor.
_GUARDED_MODULES = (
    "agent/context_references.py",
    "tools/terminal_tool.py",
    "tools/browser_tool.py",
    "tools/env_probe.py",
    "agent/prompt_builder.py",
    "agent/runtime_cwd.py",
    "cron/scheduler.py",
    "gateway/platforms/base.py",
    "gateway/run.py",
    "gateway/slash_commands.py",
    "hermes_cli/kanban_db.py",
    "tools/credential_files.py",
    "tools/file_tools.py",
    "tools/image_generation_tool.py",
    "tools/image_source.py",
    "tools/process_registry.py",
    "tools/skills_tool.py",
    "tools/vision_tools.py",
)

# The only functions allowed to touch the process environment for TERMINAL_*:
# the accessor that defines the policy, and the one-shot config→env bridge it
# delegates to on the unscoped path.
_ENV_READ_ALLOWED_IN = frozenset(
    {"get_terminal_setting", "_ensure_terminal_env_bridged"}
)

# These reads are deliberately process-global rather than routed-profile
# configuration: gateway startup/diagnostics, the host-wide local worker memory
# safety cap, and cron's serialized environment override. Keep the exceptions
# narrow to the exact module, function, and setting.
_PROCESS_GLOBAL_READS = frozenset(
    {
        ("gateway/run.py", "<module>", "TERMINAL_CWD"),
        ("gateway/run.py", "<module>", "TERMINAL_ENV"),
        ("gateway/run.py", "<module>", "TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE"),
        ("gateway/run.py", "_warn_if_docker_media_delivery_is_risky", "TERMINAL_ENV"),
        ("gateway/run.py", "_warn_if_docker_media_delivery_is_risky", "TERMINAL_DOCKER_VOLUMES"),
        ("tools/process_registry.py", "_worker_memory_max_bytes", "TERMINAL_LOCAL_MEMORY_MAX_MB"),
        ("cron/scheduler.py", "run_job", "TERMINAL_CWD"),
    }
)


def _terminal_env_reads(source: str):
    """Yield (lineno, function, expression) for each direct TERMINAL_* read."""
    import ast

    def _is_terminal_literal(node) -> bool:
        return isinstance(node, ast.Constant) and isinstance(node.value, str) and (
            node.value.startswith(_TERMINAL_ENV_PREFIX)
        )

    def _dotted(node) -> str:
        if isinstance(node, ast.Attribute):
            return f"{_dotted(node.value)}.{node.attr}"
        if isinstance(node, ast.Name):
            return node.id
        return "?"

    tree = ast.parse(source)
    # Map every node to its enclosing function so violations name a call site.
    enclosing: dict[int, str] = {}
    for parent in ast.walk(tree):
        if isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for child in ast.walk(parent):
                enclosing.setdefault(id(child), parent.name)

    for node in ast.walk(tree):
        target = None
        if isinstance(node, ast.Call) and node.args:
            callee = _dotted(node.func)
            if callee in {"os.getenv", "os.environ.get", "getenv"}:
                if _is_terminal_literal(node.args[0]):
                    target = f"{callee}({node.args[0].value!r})"
        elif isinstance(node, ast.Subscript):
            if _dotted(node.value) == "os.environ" and _is_terminal_literal(node.slice):
                target = f"os.environ[{node.slice.value!r}]"
        if target is None:
            continue
        function = enclosing.get(id(node), "<module>")
        if function in _ENV_READ_ALLOWED_IN:
            continue
        yield node.lineno, function, target


def test_no_module_reads_terminal_config_from_process_environment():
    repo_root = Path(__file__).resolve().parents[2]

    violations = []
    for relative in _GUARDED_MODULES:
        path = repo_root / relative
        assert path.exists(), f"guarded module moved or was renamed: {relative}"
        for lineno, function, expression in _terminal_env_reads(
            path.read_text(encoding="utf-8")
        ):
            setting = expression.split("'", 2)[1]
            if (relative, function, setting) in _PROCESS_GLOBAL_READS:
                continue
            violations.append(f"{relative}:{lineno} in {function}(): {expression}")

    assert not violations, (
        "TERMINAL_* settings must be read through "
        "tools.terminal_tool.get_terminal_setting() so a multiplexed gateway "
        "resolves them for the routed profile instead of whichever profile "
        "bridged its config into os.environ first (#68559).\n"
        + "\n".join(f"  - {v}" for v in violations)
    )


def test_guard_detects_a_reintroduced_process_environment_read():
    """The guard above is only useful if it actually fires — prove it does."""
    reintroduced = (
        "import os\n"
        "def _is_local_backend():\n"
        "    return os.getenv('TERMINAL_ENV', 'local') == 'local'\n"
    )
    found = list(_terminal_env_reads(reintroduced))
    assert len(found) == 1
    _lineno, function, expression = found[0]
    assert function == "_is_local_backend"
    assert "TERMINAL_ENV" in expression

    # ...and that it stays quiet for the accessor form and for prose mentions.
    compliant = (
        "import os\n"
        "def _is_local_backend():\n"
        '    """Reads os.environ["TERMINAL_ENV"] historically."""\n'
        "    return get_terminal_setting('TERMINAL_ENV', 'local') == 'local'\n"
    )
    assert not list(_terminal_env_reads(compliant))
