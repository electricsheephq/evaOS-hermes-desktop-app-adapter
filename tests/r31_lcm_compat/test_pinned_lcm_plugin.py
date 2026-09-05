"""Behavioral r31.1 fixtures for the pinned external hermes-lcm plugin.

The LCM fixture is intentionally materialized from the pinned Git object at
test time.  This keeps the repository from vendoring or replacing the plugin,
while still loading it through Hermes' real directory-plugin discovery path.
The default source is the clean detached checkout prepared for r31.1 as a
sibling of this runtime checkout. A pytest path option supports other hosts.
"""

from __future__ import annotations

import datetime as dt
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

import pytest

from hermes_cli.plugins import PluginManager


LCM_REPO_URL = "https://github.com/stephenschoettler/hermes-lcm"
LCM_COMMIT = "49e99a272d2d461e5c90732e7ef2bc20e96f0826"
LCM_TREE = "2f64bdc407d685acff55433859c0b77ea49a694b"
LCM_VERSION = "0.20.0"
OLD_RUNTIME_COMMIT = "d02f246755153b318d472e30abb960f8578f8cfa"
WORKTREE_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_LCM_SOURCE = WORKTREE_ROOT.parent / "evaos-r31-lcm-source"
DEFAULT_OLD_RUNTIME = WORKTREE_ROOT.parent / "evaos-r31-r307-baseline"
SYNTHETIC_SESSION = "r31-synthetic-session"
SYNTHETIC_CONVERSATION = "r31-synthetic-conversation"
FIRST_MARKER = "r31-pinned-lcm-first-marker"
SECOND_MARKER = "r31-pinned-lcm-restart-marker"
THIRD_MARKER = "r31-pinned-lcm-old-runtime-marker"


def _path_option(request: pytest.FixtureRequest, option: str, default: Path) -> Path:
    selected = request.config.getoption(option)
    return Path(selected).expanduser() if selected else default


def _source_checkout(request: pytest.FixtureRequest) -> Path:
    option_source = request.config.getoption("--r31-lcm-source")
    source = Path(option_source).expanduser() if option_source else DEFAULT_LCM_SOURCE
    if not source.is_dir():
        pytest.fail(
            f"Pinned LCM source checkout is missing: {source}; provide "
            f"--r31-lcm-source, or extract {LCM_REPO_URL}@{LCM_COMMIT}"
        )
    probe = subprocess.run(
        ["git", "-C", str(source), "cat-file", "-e", f"{LCM_COMMIT}^{{commit}}"],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if probe.returncode != 0:
        pytest.fail(
            f"Pinned LCM object {LCM_COMMIT} is unavailable in {source}; extract "
            f"{LCM_REPO_URL}@{LCM_COMMIT} and set --r31-lcm-source"
        )
    tree_probe = subprocess.run(
        ["git", "-C", str(source), "rev-parse", f"{LCM_COMMIT}^{{tree}}"],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if tree_probe.returncode != 0 or tree_probe.stdout.strip() != LCM_TREE:
        pytest.fail(
            f"Pinned LCM tree mismatch in {source}: expected {LCM_TREE}, got "
            f"{tree_probe.stdout.strip() or '<unavailable>'}"
        )
    return source


def _grep_snippets(payload: str) -> list[str]:
    """Return the pinned plugin's documented full-text result snippets."""
    decoded = json.loads(payload)
    assert isinstance(decoded, dict), decoded
    assert "error" not in decoded, decoded
    results = decoded.get("results")
    assert isinstance(results, list), decoded
    return [
        str(result["snippet"])
        for result in results
        if isinstance(result, dict) and "snippet" in result
    ]


def _assert_highlighted_marker(payload: str, marker_suffix: str) -> None:
    snippets = _grep_snippets(payload)
    assert any(
        ">>>pinned<<<" in snippet and marker_suffix in snippet
        for snippet in snippets
    ), snippets


def _materialize_pinned_plugin(source: Path, destination: Path) -> None:
    """Extract exactly one pinned Git tree into a temporary user-plugin directory."""
    archive = subprocess.run(
        ["git", "-C", str(source), "archive", "--format=tar", LCM_COMMIT],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ).stdout
    destination.mkdir(parents=True)
    root = destination.resolve()
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as bundle:
        for member in bundle.getmembers():
            target = (destination / member.name).resolve()
            if target != root and root not in target.parents:
                raise AssertionError(f"pinned plugin archive escapes destination: {member.name}")
        bundle.extractall(destination)

    manifest = destination / "plugin.yaml"
    assert manifest.is_file(), "pinned LCM archive did not contain plugin.yaml"
    assert "version: 0.20.0" in manifest.read_text(encoding="utf-8")


def _write_config(hermes_home: Path, plugin_name: str) -> None:
    (hermes_home / "config.yaml").write_text(
        "plugins:\n"
        f"  enabled:\n    - {plugin_name}\n"
        "  allow_deprecated_imports: false\n"
        "context:\n"
        "  engine: lcm\n",
        encoding="utf-8",
    )


def _new_manager(monkeypatch: pytest.MonkeyPatch, hermes_home: Path) -> PluginManager:
    bundled = hermes_home.parent / "empty-bundled-plugins"
    bundled.mkdir()
    monkeypatch.setenv("HOME", str(hermes_home.parent / "os-home"))
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.setenv("HERMES_BUNDLED_PLUGINS", str(bundled))
    manager = PluginManager()
    manager.discover_and_load()
    return manager


def _set_today(monkeypatch: pytest.MonkeyPatch, today: dt.date) -> None:
    class _FrozenDate(dt.date):
        @classmethod
        def today(cls):
            return today

    # plugin_compat keeps its datetime module private; changing only that
    # module's date class makes the two sides of the cutoff deterministic.
    import hermes_cli.plugin_compat as plugin_compat

    monkeypatch.setattr(plugin_compat._dt, "date", _FrozenDate)


@pytest.mark.parametrize("today", [dt.date(2026, 9, 13), dt.date(2026, 9, 15)])
def test_pinned_lcm_loads_and_dispatches_before_and_after_cutoff(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    request: pytest.FixtureRequest,
    today: dt.date,
):
    """The real v0.20.0 plugin loads and serves native tools on both sides."""
    source = _source_checkout(request)
    hermes_home = tmp_path / "hermes-home"
    (hermes_home / "plugins").mkdir(parents=True)
    _materialize_pinned_plugin(source, hermes_home / "plugins" / "hermes-lcm")
    _write_config(hermes_home, "hermes-lcm")
    _set_today(monkeypatch, today)

    manager = _new_manager(monkeypatch, hermes_home)
    loaded = manager._plugins["hermes-lcm"]
    assert loaded.enabled is True
    assert loaded.error is None
    assert loaded.manifest.version == LCM_VERSION
    assert manager._context_engine is not None
    assert manager._context_engine.name == "lcm"
    assert manager._context_engine.get_tool_schemas()
    tool_names = {schema["name"] for schema in manager._context_engine.get_tool_schemas()}
    assert {"lcm_grep", "lcm_recent", "lcm_status"}.issubset(tool_names)

    engine = manager._context_engine
    engine.on_session_start(
        SYNTHETIC_SESSION,
        hermes_home=str(hermes_home),
        platform="synthetic",
        conversation_id=SYNTHETIC_CONVERSATION,
    )
    engine.ingest(
        [
            {"role": "user", "content": FIRST_MARKER},
            {"role": "assistant", "content": "synthetic first response"},
        ]
    )
    first_result = engine.handle_tool_call("lcm_grep", {"query": "pinned"})
    _assert_highlighted_marker(first_result, "first-marker")

    first_db = hermes_home / "lcm.db"
    assert first_db.is_file()
    engine.shutdown()

    # A fresh engine instance reads the same store, then appends to it.  No
    # conversion, replacement store, or model/API call is involved here.
    restarted = type(engine)(config=engine._config, hermes_home=str(hermes_home))
    restarted.on_session_start(
        SYNTHETIC_SESSION,
        hermes_home=str(hermes_home),
        platform="synthetic",
        conversation_id=SYNTHETIC_CONVERSATION,
    )
    restarted.ingest([{"role": "user", "content": SECOND_MARKER}])
    combined_result = restarted.handle_tool_call(
        "lcm_grep", {"query": "pinned"}
    )
    _assert_highlighted_marker(combined_result, "first-marker")
    _assert_highlighted_marker(combined_result, "restart-marker")
    assert restarted.handle_tool_call("lcm_status", {})
    restarted.shutdown()


def _run_runtime_phase(
    runtime_root: Path, phase: str, hermes_home: Path
) -> dict[str, object]:
    required = (runtime_root / "agent" / "context_engine.py", runtime_root / "hermes_cli" / "plugins.py")
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        pytest.fail(f"runtime checkout is missing required source files: {missing}")
    driver = Path(__file__).parent / "fixtures" / "runtime_store_probe.py"
    env = {
        "PATH": os.environ.get("PATH", ""),
        "PYTHONPATH": str(runtime_root),
        "HERMES_HOME": str(hermes_home),
        "HOME": str(hermes_home.parent / f"{phase}-os-home"),
        "HERMES_BUNDLED_PLUGINS": str(hermes_home / "_empty-bundled-plugins"),
    }
    completed = subprocess.run(
        [sys.executable, str(driver), phase, str(hermes_home)],
        cwd=runtime_root,
        env=env,
        check=False,
        text=True,
        capture_output=True,
    )
    if completed.returncode != 0:
        pytest.fail(
            f"{phase} failed in {runtime_root} (exit {completed.returncode})\n"
            f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
        )
    try:
        result = json.loads(completed.stdout.strip().splitlines()[-1])
    except (IndexError, json.JSONDecodeError) as exc:
        pytest.fail(f"{phase} emitted no JSON receipt: {exc}; stdout={completed.stdout!r}")
    assert result.get("ok") is True, result
    return result


def test_real_old_target_old_preserves_one_lcm_store(
    tmp_path: Path, request: pytest.FixtureRequest
):
    """Old, target, then old runtimes read/append one unconverted LCM store."""
    source = _source_checkout(request)
    old_runtime = _path_option(request, "--r31-old-runtime", DEFAULT_OLD_RUNTIME)
    target_runtime = _path_option(request, "--r31-target-runtime", WORKTREE_ROOT)
    old_head = subprocess.run(
        ["git", "-C", str(old_runtime), "rev-parse", "HEAD"],
        check=True, capture_output=True, text=True,
    ).stdout.strip()
    assert old_head == OLD_RUNTIME_COMMIT, "predecessor runtime identity drift"
    hermes_home = tmp_path / "subprocess-hermes-home"
    (hermes_home / "plugins").mkdir(parents=True)
    _materialize_pinned_plugin(source, hermes_home / "plugins" / "hermes-lcm")
    _write_config(hermes_home, "hermes-lcm")

    old_seed = _run_runtime_phase(old_runtime, "old-seed", hermes_home)
    assert old_seed["seen"] == ["first"]
    store = hermes_home / "lcm.db"
    assert store.is_file()
    store_inode = store.stat().st_ino

    target_append = _run_runtime_phase(target_runtime, "target-append", hermes_home)
    assert target_append["seen"] == ["first", "target"]
    assert store.stat().st_ino == store_inode

    old_verify = _run_runtime_phase(old_runtime, "old-verify-append", hermes_home)
    assert old_verify["seen"] == ["first", "target", "old-runtime"]
    assert store.stat().st_ino == store_inode


def _install_predecessor_fixture(hermes_home: Path) -> None:
    source = Path(__file__).parent / "fixtures" / "legacy_lcm_predecessor"
    (hermes_home / "plugins").mkdir(parents=True)
    destination = hermes_home / "plugins" / "legacy-lcm-predecessor"
    shutil.copytree(source, destination)
    # This is intentionally old third-party source, not a first-party import.
    # Materialize it only inside the isolated plugin-loader fixture.
    (destination / "__init__.py").write_text(
        (source / "__init__.py.fixture").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    _write_config(hermes_home, "legacy-lcm-predecessor")


def test_predecessor_fixture_loads_before_cutoff(tmp_path, monkeypatch):
    hermes_home = tmp_path / "hermes-home"
    _install_predecessor_fixture(hermes_home)
    _set_today(monkeypatch, dt.date(2026, 9, 13))

    manager = _new_manager(monkeypatch, hermes_home)
    loaded = manager._plugins["legacy-lcm-predecessor"]
    assert loaded.enabled is True
    assert loaded.error is None
    assert manager.invoke_hook("on_session_start", session_id="synthetic-predecessor") == [
        {"compat_loaded": True, "session_id": "synthetic-predecessor"}
    ]


def test_predecessor_fixture_is_disabled_after_cutoff_without_override(tmp_path, monkeypatch):
    hermes_home = tmp_path / "hermes-home"
    _install_predecessor_fixture(hermes_home)
    _set_today(monkeypatch, dt.date(2026, 9, 15))

    manager = _new_manager(monkeypatch, hermes_home)
    loaded = manager._plugins["legacy-lcm-predecessor"]
    assert loaded.enabled is False
    assert loaded.module is None
    assert loaded.error and "2026-09-14" in loaded.error
    assert manager.invoke_hook("on_session_start", session_id="synthetic-predecessor") == []
