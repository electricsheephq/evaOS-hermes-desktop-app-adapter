"""Serve cron ticker: every intended local profile store must be ticked.

The desktop app pools per-profile backends and reaps them after ~10 idle
minutes, so a secondary profile's in-backend ticker dies with its backend and
that profile's cron jobs silently stop firing until the user next opens the
profile. The PRIMARY desktop backend outlives the pool, so its ticker must own
every profile's store — the desktop sibling of the multiplex-gateway fix for
#69377.
"""

import os
from pathlib import Path
import threading
from types import SimpleNamespace

import pytest

import hermes_cli.web_server as ws


@pytest.fixture()
def flat_managed_profile(tmp_path, monkeypatch):
    root = tmp_path / "hermes"
    home = root / "main"
    home.mkdir(parents=True)
    shared_auth = root / "shared-auth" / "auth.json"
    shared_auth.parent.mkdir()
    shared_auth.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setenv("HERMES_SHARED_AUTH_FILE", str(shared_auth))

    import pwd

    monkeypatch.setattr(os, "geteuid", lambda: 4242)
    monkeypatch.setattr(pwd, "getpwuid", lambda _uid: SimpleNamespace(pw_name="hermes-main"))
    return home


class _RecordingBuiltin:
    """Stands in for InProcessCronScheduler; records start() kwargs."""

    name = "builtin"

    def __init__(self):
        self.start_kwargs = None

    def start(self, stop_event, **kwargs):
        self.start_kwargs = kwargs


class _RecordingExternal:
    """External provider double — must NOT receive profile_homes."""

    name = "chronos-test"

    def __init__(self):
        self.start_kwargs = None

    def start(self, stop_event, **kwargs):
        self.start_kwargs = kwargs


@pytest.fixture()
def _providers(monkeypatch):
    import cron.scheduler_provider as sp

    builtin = _RecordingBuiltin()
    # isinstance(provider, InProcessCronScheduler) gate: register our double
    # as that class for the module under test.
    monkeypatch.setattr(ws, "_log", ws._log)
    monkeypatch.setattr(sp, "resolve_cron_scheduler", lambda: builtin)
    monkeypatch.setattr(sp, "InProcessCronScheduler", _RecordingBuiltin)
    return sp, builtin


def test_multi_profile_homes_passed_to_builtin(monkeypatch, _providers, tmp_path):
    _sp, builtin = _providers
    homes = [
        ("default", tmp_path / "root"),
        ("coder", tmp_path / "profiles" / "coder"),
    ]
    import hermes_cli.profiles as profiles_mod

    monkeypatch.setattr(profiles_mod, "profiles_to_serve", lambda **_kw: list(homes))

    ws._start_desktop_cron_ticker(threading.Event(), interval=7)

    assert builtin.start_kwargs is not None
    assert builtin.start_kwargs["interval"] == 7
    assert builtin.start_kwargs["profile_homes"] == homes


def test_single_profile_keeps_legacy_path(monkeypatch, _providers, tmp_path):
    _sp, builtin = _providers
    import hermes_cli.profiles as profiles_mod

    monkeypatch.delenv("HERMES_CRON_TICKER", raising=False)
    monkeypatch.setattr(
        profiles_mod,
        "profiles_to_serve",
        lambda **_kw: [("default", tmp_path / "root")],
    )

    ws._start_desktop_cron_ticker(threading.Event(), interval=9)

    assert builtin.start_kwargs == {"interval": 9}


def test_enumeration_failure_preserves_desktop_fallback_but_env_only_fails_closed(
    monkeypatch, _providers
):
    """Desktop keeps firing, while env-only serve avoids an ungated owner."""
    _sp, builtin = _providers
    import hermes_cli.profiles as profiles_mod

    def _boom(**_kw):
        raise RuntimeError("profiles dir unreadable")

    monkeypatch.setattr(profiles_mod, "profiles_to_serve", _boom)

    ws._start_desktop_cron_ticker(threading.Event(), interval=11)

    assert builtin.start_kwargs == {"interval": 11}

    builtin.start_kwargs = None
    monkeypatch.delenv("HERMES_DESKTOP", raising=False)
    monkeypatch.setenv("HERMES_CRON_TICKER", "1")
    ws._start_serve_cron_ticker(threading.Event(), interval=11)

    assert builtin.start_kwargs is None


def test_external_provider_never_gets_profile_homes(monkeypatch, tmp_path):
    """External registries are not profile-scoped; keep single-store semantics."""
    import cron.scheduler_provider as sp

    external = _RecordingExternal()
    monkeypatch.setattr(sp, "resolve_cron_scheduler", lambda: external)

    import hermes_cli.profiles as profiles_mod

    monkeypatch.setattr(
        profiles_mod,
        "profiles_to_serve",
        lambda **_kw: [("default", tmp_path / "a"), ("b", tmp_path / "b")],
    )

    ws._start_desktop_cron_ticker(threading.Event(), interval=13)

    assert external.start_kwargs == {"interval": 13}


def _capture_builtin_multiplex(monkeypatch):
    import cron.scheduler_provider as sp

    captured = {}
    monkeypatch.setattr(sp, "resolve_cron_scheduler", sp.InProcessCronScheduler)
    monkeypatch.setattr(
        sp.InProcessCronScheduler,
        "_start_multiplex",
        lambda _self, _stop_event, **kwargs: captured.update(kwargs),
    )
    return captured


def test_cron_ticker_env_uses_one_flat_managed_profile(monkeypatch, flat_managed_profile):
    monkeypatch.delenv("HERMES_DESKTOP", raising=False)
    monkeypatch.setenv("HERMES_CRON_TICKER", "1")
    captured = _capture_builtin_multiplex(monkeypatch)

    ws._start_serve_cron_ticker(threading.Event(), interval=17)

    assert captured["interval"] == 17
    assert captured["profile_homes"] == (("main", flat_managed_profile),)
    assert callable(captured["profile_gate"])


def test_one_profile_gate_rejects_held_gateway_lock(monkeypatch, flat_managed_profile):
    monkeypatch.setenv("HERMES_CRON_TICKER", "yes")
    captured = _capture_builtin_multiplex(monkeypatch)
    ws._start_serve_cron_ticker(threading.Event())

    from gateway import status

    start_time = status._get_process_start_time(os.getpid())
    monkeypatch.setattr(status, "_read_process_cmdline", lambda _pid: None)
    monkeypatch.setattr(
        status,
        "_build_pid_record",
        lambda: {
            "pid": os.getpid(),
            "kind": "hermes-gateway",
            "argv": ["python", "-m", "hermes_cli.main", "gateway"],
            "start_time": start_time,
            "hermes_home": str(flat_managed_profile.resolve()),
        },
    )
    assert status.acquire_gateway_runtime_lock() is True
    try:
        assert captured["profile_gate"]("main", flat_managed_profile) is False
    finally:
        status.release_gateway_runtime_lock()


def _client():
    try:
        from starlette.testclient import TestClient
    except ImportError:
        pytest.skip("fastapi/starlette not installed")
    return TestClient(ws.app)


def test_cron_ticker_env_does_not_reap_desktop_orphans(monkeypatch):
    import hermes_cli.gateway as gateway_mod

    started = threading.Event()
    reaped = threading.Event()
    monkeypatch.delenv("HERMES_DESKTOP", raising=False)
    monkeypatch.setenv("HERMES_CRON_TICKER", "true")
    monkeypatch.setattr(
        ws, "_start_serve_cron_ticker", lambda *_args: started.set()
    )
    monkeypatch.setattr(gateway_mod, "_reap_unsupervised_gateway_orphans", reaped.set)

    with _client():
        assert started.wait(3.0), "expected cron ticker under HERMES_CRON_TICKER"

    assert reaped.is_set() is False


def test_no_cron_ticker_without_either_env_gate(monkeypatch):
    started = threading.Event()
    monkeypatch.delenv("HERMES_DESKTOP", raising=False)
    monkeypatch.delenv("HERMES_CRON_TICKER", raising=False)
    monkeypatch.setattr(ws, "_start_serve_cron_ticker", lambda *_args: started.set())

    with _client():
        pass

    assert started.is_set() is False
