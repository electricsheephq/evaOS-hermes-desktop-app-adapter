"""Profile-scoped plugin discovery and module-isolation regressions."""

from pathlib import Path
import sys
import threading

import pytest
import yaml

import hermes_cli.plugins as plugins_mod


def _write_profile(home: Path, slug: str, value: str, *, failing: bool = False) -> Path:
    plugin_dir = home / "plugins" / slug
    plugin_dir.mkdir(parents=True)
    (plugin_dir / "plugin.yaml").write_text(
        yaml.safe_dump({"name": slug, "version": "0.1.0"}),
        encoding="utf-8",
    )
    failure = "raise RuntimeError('import failed')\n" if failing else ""
    (plugin_dir / "__init__.py").write_text(
        f"VALUE = {value!r}\n"
        "def register(ctx):\n"
        "    ctx.register_hook('transform_llm_output', lambda **kw: VALUE)\n"
        f"{failure}",
        encoding="utf-8",
    )
    (home / "config.yaml").write_text(
        yaml.safe_dump({"plugins": {"enabled": [slug]}}),
        encoding="utf-8",
    )
    return home


@pytest.fixture(autouse=True)
def _isolated_plugin_state(tmp_path, monkeypatch):
    from agent.secret_scope import is_multiplex_active, set_multiplex_active

    bundled = tmp_path / "bundled"
    bundled.mkdir()
    monkeypatch.setattr(plugins_mod, "get_bundled_plugins_dir", lambda: bundled)
    modules_before = set(sys.modules)
    multiplex_before = is_multiplex_active()
    set_multiplex_active(True)
    plugins_mod._reset_plugin_managers_for_tests()
    yield
    plugins_mod._reset_plugin_managers_for_tests()
    set_multiplex_active(multiplex_before)
    for name in set(sys.modules) - modules_before:
        if name.startswith("hermes_plugins."):
            sys.modules.pop(name, None)


def _loaded(manager, slug: str):
    return manager._plugins[slug]


def test_manager_cache_and_hooks_are_profile_scoped(tmp_path):
    from gateway.run import _profile_runtime_scope

    home_a = _write_profile(tmp_path / "a", "plugin_a", "a")
    home_b = _write_profile(tmp_path / "b", "plugin_b", "b")

    with _profile_runtime_scope(home_a):
        plugins_mod.discover_plugins()
        manager_a = plugins_mod.get_plugin_manager()
        assert manager_a.invoke_hook("transform_llm_output") == ["a"]
    with _profile_runtime_scope(home_b):
        plugins_mod.discover_plugins()
        manager_b = plugins_mod.get_plugin_manager()
        assert manager_b.invoke_hook("transform_llm_output") == ["b"]
    with _profile_runtime_scope(home_a):
        assert plugins_mod.get_plugin_manager() is manager_a

    assert manager_a is not manager_b
    assert "plugin_b" not in manager_a._plugins
    assert "plugin_a" not in manager_b._plugins


def test_concurrent_same_slug_loads_keep_private_modules_and_hooks(
    tmp_path, monkeypatch
):
    """Distinct namespaces make cross-manager discovery safe without a global lock."""
    from gateway.run import _profile_runtime_scope

    homes = {
        "a": _write_profile(tmp_path / "a", "shared", "a"),
        "b": _write_profile(tmp_path / "b", "shared", "b"),
    }
    barrier = threading.Barrier(2)
    original = plugins_mod.PluginManager._load_directory_module

    def synchronized_load(self, manifest, *, module_name=None):
        barrier.wait(timeout=2)
        return original(self, manifest, module_name=module_name)

    monkeypatch.setattr(
        plugins_mod.PluginManager,
        "_load_directory_module",
        synchronized_load,
    )
    managers = {}
    failures = []

    def discover(label: str):
        try:
            with _profile_runtime_scope(homes[label]):
                plugins_mod.discover_plugins()
                managers[label] = plugins_mod.get_plugin_manager()
        except BaseException as exc:  # pragma: no cover - assertion aid
            failures.append(exc)

    threads = [threading.Thread(target=discover, args=(label,)) for label in homes]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=5)

    assert not failures
    assert all(not thread.is_alive() for thread in threads)
    loaded_a = _loaded(managers["a"], "shared")
    loaded_b = _loaded(managers["b"], "shared")
    assert loaded_a.error is None
    assert loaded_b.error is None
    assert loaded_a.module is not loaded_b.module
    assert loaded_a.module.__name__ != loaded_b.module.__name__
    assert loaded_a.module.__name__.startswith("hermes_plugins.shared")
    assert loaded_b.module.__name__.startswith("hermes_plugins.shared")
    assert managers["a"].invoke_hook("transform_llm_output") == ["a"]
    assert managers["b"].invoke_hook("transform_llm_output") == ["b"]


def test_identical_source_is_loaded_into_distinct_profile_modules(tmp_path):
    from gateway.run import _profile_runtime_scope

    shared = _write_profile(tmp_path / "source", "shared", "shared") / "plugins" / "shared"
    managers = []
    for label in ("a", "b"):
        home = tmp_path / label
        (home / "plugins").mkdir(parents=True)
        (home / "plugins" / "shared").symlink_to(shared, target_is_directory=True)
        (home / "config.yaml").write_text(
            yaml.safe_dump({"plugins": {"enabled": ["shared"]}}),
            encoding="utf-8",
        )
        with _profile_runtime_scope(home):
            plugins_mod.discover_plugins()
            managers.append(plugins_mod.get_plugin_manager())

    first = _loaded(managers[0], "shared").module
    second = _loaded(managers[1], "shared").module
    assert first is not second
    assert first.__name__ != second.__name__
    assert managers[0].invoke_hook("transform_llm_output") == ["shared"]
    assert managers[1].invoke_hook("transform_llm_output") == ["shared"]


def test_failed_import_is_not_reused_by_a_sibling_profile(tmp_path):
    from gateway.run import _profile_runtime_scope

    failed = _write_profile(tmp_path / "a", "shared", "a", failing=True)
    healthy = _write_profile(tmp_path / "b", "shared", "b")
    managers = []
    for home in (failed, healthy):
        with _profile_runtime_scope(home):
            plugins_mod.discover_plugins()
            managers.append(plugins_mod.get_plugin_manager())

    assert "import failed" in (_loaded(managers[0], "shared").error or "")
    assert managers[0].invoke_hook("transform_llm_output") == []
    assert _loaded(managers[1], "shared").error is None
    assert managers[1].invoke_hook("transform_llm_output") == ["b"]
