"""Disposable two-profile source fixture for adapter issue #123."""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
from types import SimpleNamespace
import threading
import time

import psutil
import yaml


class _Response:
    status_code = 200
    text = ""

    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class _ReadSession:
    def __init__(self, account_id, profile_name):
        self.account_id = account_id
        self.profile_name = profile_name
        self.calls = []

    async def call_tool(self, name, arguments):
        self.calls.append((name, arguments))
        text = json.dumps(
            {
                "account_id": self.account_id,
                "profile": self.profile_name,
                "sheets": [],
            },
            sort_keys=True,
        )
        return SimpleNamespace(
            isError=False,
            content=[SimpleNamespace(type="text", text=text)],
            structuredContent=None,
        )


def _write_yaml(path: Path, value: dict) -> None:
    path.write_text(yaml.safe_dump(value, sort_keys=True), encoding="utf-8")


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@contextmanager
def _profile_scope(home: Path):
    from agent.secret_scope import (
        build_profile_secret_scope,
        reset_secret_scope,
        set_secret_scope,
    )
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    home_token = set_hermes_home_override(home)
    secret_token = set_secret_scope(build_profile_secret_scope(home))
    try:
        yield
    finally:
        reset_secret_scope(secret_token)
        reset_hermes_home_override(home_token)


def _managed_entry(app_slug: str, profile: str, account_id: str) -> dict:
    return {
        "auth": "evaos_lease",
        "app_slug": app_slug,
        "external_user_id": f"fixture_{profile}",
        "account_id": account_id,
        "lazy": True,
    }


def test_connect_noop_update_restart_preserves_same_session_and_isolation(
    tmp_path, monkeypatch
):
    from agent.secret_scope import is_multiplex_active, set_multiplex_active
    from hermes_cli import managed_scope
    from hermes_cli.config import _LOAD_CONFIG_CACHE, _RAW_CONFIG_CACHE
    from hermes_constants import get_hermes_home
    from tools import mcp_schema_cache, mcp_tool
    from tools.evaos_mcp_lease import EvaosLeaseManager, EvaosLeaseSource
    from tools.registry import ToolRegistry
    import tools.registry as registry_module

    base = tmp_path / "base"
    profiles = tmp_path / "profiles"
    managed = tmp_path / "managed"
    credentials = tmp_path / "credentials"
    for path in (base, profiles / "jane", profiles / "louis", managed / "jane",
                 managed / "louis", credentials):
        path.mkdir(parents=True)
    _write_yaml(base / "config.yaml", {"display": {"skin": "base"}})
    _write_yaml(profiles / "jane" / "config.yaml", {"display": {"skin": "jane"}})
    _write_yaml(profiles / "louis" / "config.yaml", {"display": {"skin": "louis"}})
    jane_managed = managed / "jane" / "config.yaml"
    louis_managed = managed / "louis" / "config.yaml"
    jane_v1 = {
        "mcp_servers": {
            "pipedream-google-sheets": _managed_entry(
                "google_sheets", "jane", "apn_fixture_jane"
            )
        }
    }
    louis_v1 = {
        "mcp_servers": {
            "pipedream-google-sheets": _managed_entry(
                "google_sheets", "louis", "apn_fixture_louis"
            )
        }
    }
    _write_yaml(jane_managed, jane_v1)
    _write_yaml(louis_managed, louis_v1)
    broker = credentials / "pipedream_broker"
    broker.write_text("fixture-broker-secret\n", encoding="utf-8")
    broker.chmod(0o600)

    monkeypatch.setenv("HERMES_HOME", str(base))
    monkeypatch.setenv("EVAOS_HERMES_MANAGED_PROFILE_ROOT", str(managed))
    monkeypatch.setenv("CREDENTIALS_DIRECTORY", str(credentials))
    monkeypatch.setenv(
        "EVAOS_DESKTOP_RUNTIME_SESSION_URL",
        "https://fixture.supabase.co/functions/v1/desktop-runtime-session",
    )
    monkeypatch.setenv("PIPEDREAM_AGENT_BROKER_SECRET_FILE", str(broker))
    monkeypatch.setattr(mcp_schema_cache, "write_cache_entry", lambda *_a, **_k: None)
    fresh_registry = ToolRegistry()
    monkeypatch.setattr(registry_module, "registry", fresh_registry)
    previous_multiplex = is_multiplex_active()
    set_multiplex_active(True)

    mint_rows = []
    sessions = {}

    async def _mint(profile_name, config):
        now = datetime(2026, 8, 15, tzinfo=timezone.utc)

        async def transport(_url, _headers, payload):
            mint_rows.append((profile_name, dict(payload)))
            return _Response(
                {
                    "mcp_url": "https://remote.mcp.pipedream.net/v3",
                    "headers": {
                        "Authorization": f"Bearer fixture-{profile_name}",
                        "x-pd-project-id": "proj_fixture",
                        "x-pd-environment": "production",
                        "x-pd-external-user-id": config["external_user_id"],
                        "x-pd-app-slug": config["app_slug"],
                        "x-pd-account-id": config["account_id"],
                    },
                    "expires_at": (now + timedelta(minutes=10)).isoformat(),
                }
            )

        values = {
            "EVAOS_DESKTOP_RUNTIME_SESSION_URL": os.environ[
                "EVAOS_DESKTOP_RUNTIME_SESSION_URL"
            ],
            "PIPEDREAM_AGENT_BROKER_SECRET_FILE": str(broker),
        }
        source = EvaosLeaseSource(
            profile_key=str(get_hermes_home().resolve()),
            app_slug=config["app_slug"],
            external_user_id=config["external_user_id"],
            account_id=config["account_id"],
            secret_reader=values.get,
            profile_resolver=lambda: str(get_hermes_home().resolve()),
            root_uid=os.getuid(),
            service_uid=os.getuid(),
        )
        return await EvaosLeaseManager(
            source=source, transport=transport, now=lambda: now
        ).get_lease()

    def _boot(profile_name):
        home = profiles / profile_name
        with _profile_scope(home):
            mcp_tool._ensure_mcp_loop()
            configured = mcp_tool._load_mcp_config()
            for server_name, config in configured.items():
                lease = asyncio.run(_mint(profile_name, config))
                assert lease.headers["x-pd-account-id"] == config["account_id"]
                task = mcp_tool.MCPServerTask(server_name)
                task._config = dict(config)
                task._auth_type = "evaos_lease"
                task.session = _ReadSession(config["account_id"], profile_name)
                task._tools = [
                    SimpleNamespace(
                        name="list_spreadsheets",
                        description="Harmless disposable read",
                        inputSchema={"type": "object", "properties": {}},
                        annotations={"readOnlyHint": True},
                    )
                ]
                mcp_tool._record_tool_trust_metadata(
                    server_name, config, task._tools
                )
                with mcp_tool._lock:
                    mcp_tool._servers[server_name] = task
                task._registered_tool_names = mcp_tool._register_server_tools(
                    server_name, task, config
                )
                sessions[(profile_name, server_name)] = task.session
            return configured

    def _read(profile_name, server_name="pipedream-google-sheets"):
        home = profiles / profile_name
        tool_name = mcp_tool.mcp_prefixed_tool_name(
            server_name, "list_spreadsheets"
        )
        with _profile_scope(home):
            definitions = fresh_registry.get_definitions({tool_name})
            assert [row["function"]["name"] for row in definitions] == [tool_name]
            result = fresh_registry.dispatch(tool_name, {})
        return json.loads(json.loads(result)["result"])

    ordinary_session = {
        "id": "fixture-existing-session",
        "profile": "jane",
        "transcript": [{"role": "user", "content": "keep this turn"}],
    }
    original_session = json.dumps(ordinary_session, sort_keys=True)
    protected_hashes = {
        "base": _sha(base / "config.yaml"),
        "louis": _sha(louis_managed),
    }

    try:
        jane_loaded = _boot("jane")
        louis_loaded = _boot("louis")
        assert set(jane_loaded) == {"pipedream-google-sheets"}
        assert set(louis_loaded) == {"pipedream-google-sheets"}
        assert _read("jane") == {
            "account_id": "apn_fixture_jane", "profile": "jane", "sheets": []
        }
        assert _read("louis") == {
            "account_id": "apn_fixture_louis", "profile": "louis", "sheets": []
        }

        # No-op publish: byte-identical managed config changes nothing and
        # mints no extra lease without the supported gateway restart.
        jane_bytes = jane_managed.read_bytes()
        jane_managed.write_bytes(jane_bytes)
        managed_scope.invalidate_managed_cache()
        _LOAD_CONFIG_CACHE.clear()
        _RAW_CONFIG_CACHE.clear()
        with _profile_scope(profiles / "jane"):
            assert mcp_tool._load_mcp_config() == jane_loaded
        assert len(mint_rows) == 2

        jane_v2 = {
            "mcp_servers": {
                **jane_v1["mcp_servers"],
                "pipedream-google-drive": _managed_entry(
                    "google_drive", "jane", "apn_fixture_jane"
                ),
            }
        }
        _write_yaml(jane_managed, jane_v2)
        managed_scope.invalidate_managed_cache()
        _LOAD_CONFIG_CACHE.clear()
        _RAW_CONFIG_CACHE.clear()
        with _profile_scope(profiles / "jane"):
            assert fresh_registry.get_entry(
                mcp_tool.mcp_prefixed_tool_name(
                    "pipedream-google-drive", "list_spreadsheets"
                )
            ) is None

        # Supported propagation: one gateway restart tears down every profile
        # scope, then each profile discovers only its own managed config.
        mcp_tool.shutdown_mcp_servers()
        for profile_name in ("jane", "louis"):
            with _profile_scope(profiles / profile_name):
                assert fresh_registry.get_entry(
                    mcp_tool.mcp_prefixed_tool_name(
                        "pipedream-google-sheets", "list_spreadsheets"
                    )
                ) is None
        _boot("jane")
        _boot("louis")
        assert _read("jane", "pipedream-google-drive") == {
            "account_id": "apn_fixture_jane", "profile": "jane", "sheets": []
        }
        assert _read("louis")["account_id"] == "apn_fixture_louis"
        assert json.dumps(ordinary_session, sort_keys=True) == original_session
        assert _sha(base / "config.yaml") == protected_hashes["base"]
        assert _sha(louis_managed) == protected_hashes["louis"]
        assert all(
            row[1]["account_id"]
            == ("apn_fixture_jane" if row[0] == "jane" else "apn_fixture_louis")
            for row in mint_rows
        )
    finally:
        mcp_tool.shutdown_mcp_servers()
        for state in (
            mcp_tool._mcp_tool_server_names,
            mcp_tool._server_trust_levels,
            mcp_tool._tool_read_only_hints,
        ):
            state.clear_all()
        set_multiplex_active(previous_multiplex)


def test_ten_children_plus_nested_settle_with_bounded_descriptors(
    tmp_path, monkeypatch
):
    from tools import async_delegation as ad
    from tools.process_registry import process_registry

    monkeypatch.setattr(ad, "_db_path", lambda: tmp_path / "state.db")
    ad._reset_for_tests()
    while not process_registry.completion_queue.empty():
        process_registry.completion_queue.get_nowait()

    process = psutil.Process()
    baseline_fds = process.num_fds()
    peaks = []
    settled = []

    try:
        for wave in range(3):
            gate = threading.Event()
            nested_ids = []

            def nested_runner():
                gate.wait(timeout=5)
                return {"status": "completed", "summary": "nested settled"}

            def parent_runner():
                nested = ad.dispatch_async_delegation(
                    goal=f"nested-{wave}",
                    context=None,
                    toolsets=None,
                    role="leaf",
                    model="fixture",
                    session_key=f"fixture:{wave}:nested",
                    runner=nested_runner,
                    max_async_children=20,
                )
                assert nested["status"] == "dispatched"
                nested_ids.append(nested["delegation_id"])
                gate.wait(timeout=5)
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    with ad._records_lock:
                        status = ad._records[nested["delegation_id"]]["status"]
                    if status == "completed":
                        return {"status": "completed", "summary": "parent settled"}
                    time.sleep(0.01)
                raise AssertionError("nested delegation did not settle")

            def child_runner():
                gate.wait(timeout=5)
                return {"status": "completed", "summary": "child settled"}

            roots = []
            for index in range(10):
                result = ad.dispatch_async_delegation(
                    goal=f"child-{wave}-{index}",
                    context=None,
                    toolsets=None,
                    role="leaf",
                    model="fixture",
                    session_key=f"fixture:{wave}:{index}",
                    runner=parent_runner if index == 0 else child_runner,
                    max_async_children=20,
                )
                assert result["status"] == "dispatched"
                roots.append(result["delegation_id"])

            deadline = time.monotonic() + 5
            while not nested_ids and time.monotonic() < deadline:
                time.sleep(0.01)
            assert len(nested_ids) == 1
            peaks.append(process.num_fds())
            gate.set()

            events = []
            deadline = time.monotonic() + 10
            while len(events) < 11 and time.monotonic() < deadline:
                try:
                    events.append(process_registry.completion_queue.get(timeout=0.1))
                except Exception:
                    pass
            assert {event["delegation_id"] for event in events} == {
                *roots,
                nested_ids[0],
            }
            order = [event["delegation_id"] for event in events]
            assert order.index(nested_ids[0]) < order.index(roots[0])
            assert all(event["status"] == "completed" for event in events)
            assert ad.active_count() == 0
            settled.append(process.num_fds())

        assert max(peaks) <= baseline_fds + 12
        assert max(settled) <= baseline_fds + 3
        assert settled[-1] <= settled[0] + 1
    finally:
        ad._reset_for_tests()
        while not process_registry.completion_queue.empty():
            process_registry.completion_queue.get_nowait()
