"""Empty managed mappings leave profile settings writable; falsy leaves remain pinned."""

import copy

import pytest
import yaml


@pytest.fixture
def homes(tmp_path, monkeypatch):
    home = tmp_path / "home"
    managed = tmp_path / "managed"
    home.mkdir()
    managed.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_MANAGED_DIR", str(managed))
    from hermes_cli import config, managed_scope

    config._LOAD_CONFIG_CACHE.clear()
    config._RAW_CONFIG_CACHE.clear()
    managed_scope.invalidate_managed_cache()
    yield home, managed
    managed_scope.invalidate_managed_cache()


@pytest.mark.parametrize(
    ("managed_config", "expected_keys"),
    [
        ({"mcp_servers": {}}, set()),
        ({"plugins": {"entries": {}}}, set()),
        *[({"setting": value}, {"setting"}) for value in (None, [], "", False, 0)],
        (
            {"mcp_servers": {"managed-one": {"url": "https://managed.example/mcp"}}},
            {"mcp_servers.managed-one.url"},
        ),
    ],
)
def test_only_non_mapping_leaves_are_managed(homes, managed_config, expected_keys):
    from hermes_cli import managed_scope

    (homes[1] / "config.yaml").write_text(yaml.safe_dump(managed_config), encoding="utf-8")

    assert managed_scope.managed_config_keys() == expected_keys
    assert not managed_scope.is_key_managed("mcp_servers")
    for key in expected_keys:
        assert managed_scope.is_key_managed(key)


@pytest.mark.parametrize("merge_existing", [False, True])
@pytest.mark.parametrize("managed_servers", [{}, {"managed-one": {"url": "https://managed.example/mcp"}}])
def test_profile_mcp_read_and_writes_preserve_unmanaged_servers(
    homes, capsys, merge_existing, managed_servers
):
    from hermes_cli import config, managed_scope
    from hermes_cli.config_effective import load_user_config_effective

    home, managed = homes
    own_servers = {"my-server": {"url": "https://profile.example/mcp"}}
    (home / "config.yaml").write_text(
        yaml.safe_dump({"mcp_servers": own_servers}), encoding="utf-8"
    )
    (managed / "config.yaml").write_text(
        yaml.safe_dump({"mcp_servers": managed_servers}), encoding="utf-8"
    )

    expected_view = {**own_servers, **managed_servers}
    assert managed_scope.expand_managed_config()["mcp_servers"] == managed_servers
    assert config.load_config()["mcp_servers"] == expected_view
    assert load_user_config_effective()["mcp_servers"] == expected_view

    config.set_config_value("mcp_servers.x.url", "https://added.example/mcp")
    own_servers["x"] = {"url": "https://added.example/mcp"}
    assert config.read_raw_config()["mcp_servers"] == own_servers
    if managed_servers:
        with pytest.raises(SystemExit) as exc:
            config.set_config_value("mcp_servers.managed-one.url", "https://override.example/mcp")
        assert exc.value.code == 1
    capsys.readouterr()

    # Full replacement supplies the existing servers; partial saves rely on merge_existing.
    candidate = {} if merge_existing else copy.deepcopy(own_servers)
    candidate.update(copy.deepcopy(managed_servers))
    candidate["new-server"] = {"url": "https://new.example/mcp"}
    config.save_config({"mcp_servers": candidate}, merge_existing=merge_existing)

    saved = config.read_raw_config()["mcp_servers"]
    own_servers["new-server"] = candidate["new-server"]
    assert {name: saved[name] for name in own_servers} == own_servers
    for name in managed_servers:
        assert "url" not in saved.get(name, {})
    note = capsys.readouterr().err
    if managed_servers:
        assert "mcp_servers.managed-one.url" in note
    else:
        assert "managed setting(s) were not saved" not in note
        assert "mcp_servers" not in note
    assert load_user_config_effective()["mcp_servers"] == {
        **saved, **managed_servers
    }
