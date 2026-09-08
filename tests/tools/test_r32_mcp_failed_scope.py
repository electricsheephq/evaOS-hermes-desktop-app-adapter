"""Failed MCP discovery and shutdown retain the selected profile's health identity."""
import asyncio


def test_same_name_failed_discovery_and_shutdown_are_profile_scoped(tmp_path, monkeypatch):
    from agent import secret_scope
    from hermes_constants import hermes_home_key, set_hermes_home_override, reset_hermes_home_override
    from tools import mcp_tool as core, mcp_tool_discovery as discovery, mcp_tool_lifecycle as lifecycle

    monkeypatch.setattr(secret_scope, '_MULTIPLEX_ACTIVE', True)
    for name in ('_servers', '_server_scope_keys', '_server_connect_errors',
                 '_server_connect_retry_after', '_server_connect_failures', '_lazy_server_configs'):
        monkeypatch.setattr(core, name, {})
    monkeypatch.setattr(core, '_server_connecting', set())
    monkeypatch.setattr(lifecycle._loop, '_stop_mcp_loop', lambda **_kwargs: None)

    async def unavailable(_name, _config):
        raise RuntimeError('synthetic unavailable server')

    monkeypatch.setattr(discovery, '_connect_server', unavailable)
    configured = {'shared': {'command': 'synthetic-test-command', 'connect_timeout': 1}}
    homes = [tmp_path / 'a', tmp_path / 'b']
    for home in homes:
        home.mkdir()
        token = set_hermes_home_override(home)
        try:
            candidates = discovery._select_new_servers(configured)
            asyncio.run(discovery._discover_all(candidates))
            assert discovery.get_mcp_status(configured)[0]['status'] == 'failed'
        finally:
            reset_hermes_home_override(token)

    lifecycle.shutdown_mcp_servers(scope=hermes_home_key(homes[0]))
    for home, expected in zip(homes, ('configured', 'failed')):
        token = set_hermes_home_override(home)
        try:
            assert discovery.get_mcp_status(configured)[0]['status'] == expected
            key = core._server_state_key('shared')
            assert (key in core._server_connect_retry_after) == (expected == 'failed')
        finally:
            reset_hermes_home_override(token)
