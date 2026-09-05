"""Real discovery regression for same-name MCP servers in multiplexed profiles."""

import asyncio
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest


class _SyntheticServer:
    """Small connected task double returned by the real discovery seam."""

    def __init__(self, name: str, home: Path, label: str):
        self.name = name
        self.registration_home = str(home.resolve())
        self.state_key = (self.registration_home, name)
        self.session = _SyntheticSession(label)
        self.tool_timeout = 30.0
        self._tools = [SimpleNamespace(
            name=f"who_{label}",
            description=f"synthetic {label}",
            annotations={"readOnlyHint": True},
        )]
        self._registered_tool_names = []
        self.initialize_result = None
        self._sampling = None
        self._rpc_lock = asyncio.Lock()
        self._inflight_tasks = set()
        self._reconnecting = False
        self._pending_call_context = None
        self._stdio_child_pids = set()
        self._reconnect_event = threading.Event()

    def mark_tool_call(self):
        pass


class _SyntheticSession:
    def __init__(self, label: str):
        self.label = label
        self.calls: list[tuple[str, dict]] = []

    async def call_tool(self, name: str, *, arguments: dict):
        self.calls.append((name, arguments))
        return SimpleNamespace(
            isError=False,
            content=[SimpleNamespace(type="text", text=f"served-by-{self.label}")],
        )


@pytest.mark.parametrize("profile_order", [("a", "b"), ("b", "a")])
def test_real_discovery_keeps_same_name_live_connections_profile_scoped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, profile_order: tuple[str, str]
) -> None:
    """A same-name discovery pass must adopt both profile-owned tasks.

    The connector is synthetic, but ``register_mcp_servers`` and its real
    selection, adoption, registration, and status paths remain exercised.
    No scoped entry is manually inserted into a live map.
    """
    from agent import secret_scope
    from hermes_constants import hermes_home_key, reset_hermes_home_override, set_hermes_home_override
    from tools import mcp_tool
    from tools import mcp_tool_config as mcp_config
    from tools import mcp_tool_discovery as discovery
    from tools import mcp_tool_registration as registration
    from tools.registry import registry

    homes = {label: tmp_path / f"profile-{label}" for label in ("a", "b")}
    for home in homes.values():
        home.mkdir()
    tasks = {
        label: _SyntheticServer("shared", home, label)
        for label, home in homes.items()
    }

    async def fake_connect(name: str, config: dict):
        active_home = str(Path(config["synthetic_home"]).resolve())
        label = next(label for label, home in homes.items() if str(home.resolve()) == active_home)
        return tasks[label]

    def run_on_loop(coro_or_factory, timeout=30):
        return __import__("asyncio").run(
            coro_or_factory() if callable(coro_or_factory) else coro_or_factory
        )

    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", True)
    monkeypatch.setattr(mcp_tool, "_MCP_AVAILABLE", True)
    monkeypatch.setattr(mcp_tool, "_ensure_mcp_sdk", lambda: True)
    monkeypatch.setattr(mcp_config, "_filter_suspicious_mcp_servers", lambda servers: servers)
    monkeypatch.setattr(discovery, "_connect_server", fake_connect)
    monkeypatch.setattr(discovery._loop, "_ensure_mcp_loop", lambda: None)
    monkeypatch.setattr(discovery._loop, "_run_on_mcp_loop", run_on_loop)
    monkeypatch.setattr(registration, "_write_schema_cache", lambda *args, **kwargs: None)

    config_for = lambda label: {"command": "synthetic", "synthetic_home": str(homes[label])}
    try:
        for label in profile_order:
            token = set_hermes_home_override(homes[label])
            try:
                discovery.register_mcp_servers({"shared": config_for(label)})
            finally:
                reset_hermes_home_override(token)

        assert set(mcp_tool._servers) == {
            (str(homes["a"].resolve()), "shared"),
            (str(homes["b"].resolve()), "shared"),
        }
    finally:
        for label, home in homes.items():
            scope = hermes_home_key(home)
            for tool_name in tasks[label]._registered_tool_names:
                registry.deregister(tool_name, scope=scope)
                registration._forget_mcp_tool_server(tool_name, registration_home=str(home.resolve()))
        with mcp_tool._lock:
            mcp_tool._servers.clear()
            mcp_tool._server_scope_keys.clear()
            mcp_tool._server_connecting.clear()
            mcp_tool._server_connect_errors.clear()
            mcp_tool._mcp_tool_server_names.clear()


def test_profile_captured_handlers_status_and_reconnect_are_owner_scoped(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from agent import secret_scope
    from hermes_constants import hermes_home_key, reset_hermes_home_override, set_hermes_home_override
    from tools import mcp_tool
    from tools import mcp_tool_config as mcp_config
    from tools import mcp_tool_discovery as discovery
    from tools import mcp_tool_loop as loop
    from tools import mcp_tool_registration as registration
    from tools.registry import registry

    homes = {label: tmp_path / f"profile-{label}" for label in ("a", "b")}
    for home in homes.values():
        home.mkdir()
    tasks = {label: _SyntheticServer("shared", home, label) for label, home in homes.items()}

    async def fake_connect(name: str, config: dict):
        label = config["label"]
        return tasks[label]

    def run_on_loop(coro_or_factory, timeout=30):
        return asyncio.run(coro_or_factory() if callable(coro_or_factory) else coro_or_factory)

    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", True)
    monkeypatch.setattr(mcp_tool, "_MCP_AVAILABLE", True)
    monkeypatch.setattr(mcp_tool, "_ensure_mcp_sdk", lambda: True)
    monkeypatch.setattr(mcp_config, "_filter_suspicious_mcp_servers", lambda servers: servers)
    monkeypatch.setattr(mcp_config, "_load_mcp_config", lambda: {
        "shared": {"command": "synthetic", "label": "a"},
    })
    monkeypatch.setattr(discovery, "_connect_server", fake_connect)
    monkeypatch.setattr(discovery._loop, "_ensure_mcp_loop", lambda: None)
    monkeypatch.setattr(discovery._loop, "_run_on_mcp_loop", run_on_loop)
    monkeypatch.setattr(registration, "_write_schema_cache", lambda *args, **kwargs: None)
    monkeypatch.setattr(registration, "_select_utility_schemas", lambda *args, **kwargs: [])

    def discover(label: str):
        token = set_hermes_home_override(homes[label])
        try:
            return discovery.register_mcp_servers({
                "shared": {"command": "synthetic", "label": label},
            })
        finally:
            reset_hermes_home_override(token)

    try:
        discover("a")
        discover("b")
        names = {
            label: tasks[label]._registered_tool_names[0]
            for label in homes
        }
        entries = {
            label: registry.get_entry(names[label], scope=hermes_home_key(homes[label]))
            for label in homes
        }
        assert all(entries.values())

        token = set_hermes_home_override(homes["a"])
        try:
            assert entries["a"].handler({}) == '{"result": "served-by-a"}'
            assert "active profile" in entries["b"].handler({})
            status_a = discovery.get_mcp_status()
            assert status_a == [{
                "name": "shared", "transport": "stdio", "tools": 1,
                "connected": True, "disabled": False, "status": "connected",
            }]
        finally:
            reset_hermes_home_override(token)
        token = set_hermes_home_override(homes["b"])
        try:
            assert entries["b"].handler({}) == '{"result": "served-by-b"}'
            status_b = discovery.get_mcp_status()
            assert status_b == [{
                "name": "shared", "transport": "stdio", "tools": 1,
                "connected": True, "disabled": False, "status": "connected",
            }]
        finally:
            reset_hermes_home_override(token)

        token = set_hermes_home_override(homes["a"])
        try:
            assert loop.reconnect_mcp_server("shared") is True
            assert tasks["a"]._reconnect_event.is_set()
        finally:
            reset_hermes_home_override(token)
        token = set_hermes_home_override(homes["b"])
        try:
            assert loop.reconnect_mcp_server("shared") is True
            assert tasks["b"]._reconnect_event.is_set()
        finally:
            reset_hermes_home_override(token)

        assert tasks["a"].session.calls == [(tasks["a"]._tools[0].name, {})]
        assert tasks["b"].session.calls == [(tasks["b"]._tools[0].name, {})]
    finally:
        for label, home in homes.items():
            scope = hermes_home_key(home)
            for tool_name in tasks[label]._registered_tool_names:
                registry.deregister(tool_name, scope=scope)
                registration._forget_mcp_tool_server(tool_name, registration_home=str(home.resolve()))
        with mcp_tool._lock:
            mcp_tool._servers.clear()
            mcp_tool._server_scope_keys.clear()
            mcp_tool._server_connecting.clear()
            mcp_tool._server_connect_errors.clear()
            mcp_tool._mcp_tool_server_names.clear()
