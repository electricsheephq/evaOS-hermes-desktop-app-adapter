"""r34 pinned LCM-X identity: the managed plugin source loads through Hermes' real directory-plugin path.

The plugin is materialized from the pinned Git object at test time (never vendored). It must load as
``hermes-lcm-x`` and register the ``lcm-x`` context engine from a config that names only the new
identity. A profile that still enables only the retired ``hermes-lcm`` name loads without error, gets
no ``lcm-x`` engine, and its agent falls back to the built-in compressor. Positive control: the same
load test pointed at the r31 source (``--r34-lcmx-source`` / ``--r34-lcmx-ref`` =
stephenschoettler/hermes-lcm 49e99a27) fails, because that tree is ``hermes-lcm`` / engine ``lcm``.
"""

from __future__ import annotations

import io
import json
from pathlib import Path
import subprocess
import tarfile

import pytest

from agent import agent_init
from hermes_cli import plugins as hermes_plugins
from hermes_cli.plugins import PluginManager
from tests.r34_compat import _pair as pair

SYNTHETIC_SESSION = "r34-synthetic-session"
SYNTHETIC_CONVERSATION = "r34-synthetic-conversation"
FIRST_MARKER = "r34-pinned-lcmx-first-marker"
SECOND_MARKER = "r34-pinned-lcmx-restart-marker"


def _materialize(source: Path, ref: str, destination: Path) -> None:
    """Extract exactly one Git tree into a temporary user-plugin directory."""
    archive = subprocess.run(["git", "-C", str(source), "archive", "--format=tar", ref],
                             check=True, capture_output=True).stdout
    destination.mkdir(parents=True)
    root = destination.resolve()
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as bundle:
        for member in bundle.getmembers():
            target = (destination / member.name).resolve()
            if target != root and root not in target.parents:
                raise AssertionError(f"plugin archive escapes destination: {member.name}")
        bundle.extractall(destination)
    assert (destination / "plugin.yaml").is_file(), "archive did not contain plugin.yaml"


def _new_manager(monkeypatch: pytest.MonkeyPatch, hermes_home: Path) -> PluginManager:
    bundled = hermes_home.parent / "empty-bundled-plugins"
    bundled.mkdir()
    monkeypatch.setenv("HOME", str(hermes_home.parent / "os-home"))
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.setenv("HERMES_BUNDLED_PLUGINS", str(bundled))
    manager = PluginManager()
    manager.discover_and_load()
    return manager


def _grep_hits(payload: str) -> list[str]:
    decoded = json.loads(payload)
    assert isinstance(decoded, dict) and "error" not in decoded, decoded
    return [json.dumps(result) for result in decoded.get("results") or []]


def test_lcmx_source_is_the_pinned_release(request: pytest.FixtureRequest) -> None:
    source, ref = pair.lcmx_source(request.config)
    assert ref == pair.LCMX_COMMIT
    assert pair.git_head(source) == pair.LCMX_COMMIT
    tree = subprocess.run(["git", "-C", str(source), "rev-parse", f"{ref}^{{tree}}"],
                          check=True, capture_output=True, text=True).stdout.strip()
    assert tree == pair.LCMX_TREE
    manifest = subprocess.run(["git", "-C", str(source), "show", f"{ref}:plugin.yaml"],
                              check=True, capture_output=True, text=True).stdout
    assert f"name: {pair.LCMX_PLUGIN}\n" in manifest
    assert f"version: {pair.LCMX_VERSION}\n" in manifest


def test_pinned_lcmx_loads_as_hermes_lcm_x_and_serves_the_lcm_x_engine(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest
) -> None:
    source, ref = pair.lcmx_source(request.config)
    hermes_home = tmp_path / "hermes-home"
    (hermes_home / "plugins").mkdir(parents=True)
    _materialize(source, ref, hermes_home / "plugins" / pair.LCMX_PLUGIN)
    (hermes_home / "config.yaml").write_text(
        "plugins:\n"
        f"  enabled:\n    - {pair.LCMX_PLUGIN}\n"
        "  allow_deprecated_imports: false\n"
        "context:\n"
        f"  engine: {pair.LCMX_ENGINE}\n",
        encoding="utf-8",
    )

    manager = _new_manager(monkeypatch, hermes_home)
    assert pair.RETIRED_PLUGIN not in manager._plugins
    loaded = manager._plugins.get(pair.LCMX_PLUGIN)
    assert loaded is not None, sorted(manager._plugins)
    assert loaded.error is None
    assert loaded.enabled is True
    assert loaded.manifest.name == pair.LCMX_PLUGIN
    assert loaded.manifest.key == pair.LCMX_PLUGIN  # the native plugin id Hermes enables and routes by
    assert loaded.manifest.version == pair.LCMX_VERSION
    engine = manager._context_engine
    assert engine is not None and engine.name == pair.LCMX_ENGINE
    tool_names = {schema["name"] for schema in engine.get_tool_schemas()}
    assert {"lcm_grep", "lcm_recent", "lcm_status"} <= tool_names

    engine.on_session_start(SYNTHETIC_SESSION, hermes_home=str(hermes_home), platform="synthetic",
                            conversation_id=SYNTHETIC_CONVERSATION)
    engine.ingest([{"role": "user", "content": FIRST_MARKER},
                   {"role": "assistant", "content": "synthetic first response"}])
    assert any("first-marker" in hit for hit in _grep_hits(engine.handle_tool_call("lcm_grep", {"query": "pinned"})))
    assert (hermes_home / "lcm.db").is_file()
    engine.shutdown()

    # A fresh engine instance reads the same store and appends to it; no conversion or model call.
    restarted = type(engine)(config=engine._config, hermes_home=str(hermes_home))
    restarted.on_session_start(SYNTHETIC_SESSION, hermes_home=str(hermes_home), platform="synthetic",
                               conversation_id=SYNTHETIC_CONVERSATION)
    restarted.ingest([{"role": "user", "content": SECOND_MARKER}])
    hits = _grep_hits(restarted.handle_tool_call("lcm_grep", {"query": "pinned"}))
    assert any("first-marker" in hit for hit in hits) and any("restart-marker" in hit for hit in hits)
    assert restarted.handle_tool_call("lcm_status", {})
    restarted.shutdown()


@pytest.mark.parametrize("engine", ["lcm", pair.LCMX_ENGINE])
def test_a_profile_enabling_only_the_retired_name_falls_back_to_the_built_in_compressor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest, engine: str
) -> None:
    """The pinned plugin is installed, but the config names only ``hermes-lcm`` (no such plugin in the
    pinned source) with either engine name: discovery loads cleanly, nothing registers ``lcm-x``, and
    the agent's context-engine selection resolves to the built-in compressor."""
    source, ref = pair.lcmx_source(request.config)
    hermes_home = tmp_path / "hermes-home"
    (hermes_home / "plugins").mkdir(parents=True)
    _materialize(source, ref, hermes_home / "plugins" / pair.LCMX_PLUGIN)
    (hermes_home / "config.yaml").write_text(
        "plugins:\n"
        f"  enabled:\n    - {pair.RETIRED_PLUGIN}\n"
        "  allow_deprecated_imports: false\n"
        "context:\n"
        f"  engine: {engine}\n",
        encoding="utf-8",
    )

    hermes_plugins._reset_plugin_managers_for_tests()
    try:
        manager = _new_manager(monkeypatch, hermes_home)
        monkeypatch.setattr(hermes_plugins, "_plugin_manager", manager)  # the agent path's manager
        assert hermes_plugins.get_plugin_manager() is manager
        assert pair.RETIRED_PLUGIN not in manager._plugins
        assert all(loaded.error is None for loaded in manager._plugins.values() if loaded.enabled)
        installed = manager._plugins[pair.LCMX_PLUGIN]  # discovered, skipped: not named in the config
        assert installed.enabled is False and installed.error.startswith("not enabled in config"), installed
        assert manager._context_engine is None
        assert hermes_plugins.get_plugin_context_engine() is None
        assert agent_init._select_context_engine({"context": {"engine": engine}}) is None  # built-in
    finally:
        hermes_plugins._reset_plugin_managers_for_tests()
