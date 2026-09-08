"""r32 startup contracts: managed SOUL/config persistence and ticker lifetime."""
import asyncio
from pathlib import Path

import pytest
import yaml


def test_managed_startup_preserves_config40_and_soul_unmanaged_migrates(tmp_path, monkeypatch):
    from hermes_cli import config, managed_scope

    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    managed = tmp_path / 'managed'
    managed.mkdir()
    home = tmp_path / '.hermes'
    home.mkdir()
    sibling = home / 'profiles' / 'other'
    sibling.mkdir(parents=True)
    monkeypatch.setenv('HERMES_HOME', str(home))
    monkeypatch.setenv('HERMES_MANAGED_DIR', str(managed))
    original = b'# Fixture\n\n## Messaging other agents\nKeep this managed instruction.\n\n## Work\nKeep work.\n'
    for profile in (home, sibling):
        (profile / 'SOUL.md').write_bytes(original)
    cfg = home / 'config.yaml'
    cfg.write_text('_config_version: 40\nmodel:\n  default: fixture-model\n')
    config_bytes = cfg.read_bytes()
    managed_scope.invalidate_managed_cache()
    try:
        config.migrate_config(interactive=False, quiet=True)
        config.load_config()
        assert yaml.safe_load(cfg.read_text())['_config_version'] == 40
        assert cfg.read_bytes() == config_bytes
        assert all((p / 'SOUL.md').read_bytes() == original for p in (home, sibling))

        monkeypatch.delenv('HERMES_MANAGED_DIR')
        managed_scope.invalidate_managed_cache()
        config.migrate_config(interactive=False, quiet=True)
        config.load_config()
        assert yaml.safe_load(cfg.read_text())['_config_version'] == config.DEFAULT_CONFIG['_config_version']
        for profile in (home, sibling):
            changed = (profile / 'SOUL.md').read_bytes()
            assert b'## Messaging other agents' not in changed
            assert b'## Work\nKeep work.' in changed
    finally:
        managed_scope.invalidate_managed_cache()


@pytest.mark.parametrize('ssh_session_token', ['', 'synthetic-test-token'])
def test_ticker_idle_retirement_requires_ssh_token(tmp_path, monkeypatch, ssh_session_token):
    """PCS ticker hosts have no SSH token; SSH-isolated ticker hosting is unsupported.

    The isolated case deliberately retires even with a due job. PCS must never
    pass --ssh-session-token-file to its persistent ticker host.
    """
    import hermes_cli.web_server as ws
    import hermes_cli.web_server_idle_exit as idle
    from cron.jobs import create_job, update_job, get_due_jobs

    monkeypatch.setenv('HERMES_HOME', str(tmp_path))
    monkeypatch.setenv('HERMES_CRON_TICKER', '1')
    monkeypatch.delenv('HERMES_DESKTOP', raising=False)
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    job = create_job(prompt='synthetic idle ticker fixture', schedule='every 1m')
    update_job(job['id'], {'next_run_at': '2000-01-01T00:00:00+00:00'})
    assert any(due['id'] == job['id'] for due in get_due_jobs())
    clock = {'t': 0.0}
    tracker = idle.IdleClientTracker(now=lambda: clock['t'])
    monkeypatch.setattr(idle, 'IdleClientTracker', lambda: tracker)
    monkeypatch.setattr(ws.app.state, 'auth_required', False, raising=False)
    _, server = ws._build_uvicorn_server('127.0.0.1', 0, ssh_isolated=bool(ssh_session_token))
    server.servers = []
    monkeypatch.setattr(ws, '_best_effort', lambda *_args: None)
    monkeypatch.setattr(ws, '_start_parent_death_watchdog', lambda: None)
    monkeypatch.setattr(ws, '_write_dashboard_ready_file', lambda *_args: None)
    monkeypatch.setattr(ws, '_write_machine_sentinel_line', lambda *_args: None)
    monkeypatch.setattr(ws, '_maybe_open_browser', lambda *_args: None)
    monkeypatch.setattr(ws, 'load_config', lambda: {'dashboard': {'ssh_isolated_idle_grace_s': 900}})
    armed = []

    def record_watchdog(target, tracked, *, grace_s):
        armed.append((target, tracked, grace_s))

    monkeypatch.setattr(idle, 'start_idle_watchdog', record_watchdog)

    async def startup():
        ws._on_server_started(server, host='127.0.0.1', port=0, headless=True,
                              open_browser=False, initial_profile='', start_mcp_discovery_after_bind=False)

    try:
        asyncio.run(startup())
        clock['t'] = 901.0
        for target, tracked, grace in armed:
            target.should_exit = idle.should_exit_idle(tracked, grace, probe=lambda: False)
        if ssh_session_token:
            assert len(armed) == 1
            assert server.should_exit is True
        else:
            assert armed == []
            assert getattr(ws.app.state, 'ssh_isolated_clients', None) is None
            assert server.should_exit is False
    finally:
        ws.app.state._state.pop('ssh_isolated_clients', None)
