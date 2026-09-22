"""Tests for the parked-server self-probe revival path (#57129).

Parking deregisters a server's tools, so no tool call can reach the
circuit-breaker half-open probe or ``_signal_reconnect`` — the only
things that set ``_reconnect_event``. The parked wait must therefore be
timed: the run task wakes on ``_PARKED_RETRY_INTERVAL`` and attempts one
revival probe on its own.

Also covers the log hygiene of that timed probe (#337): a server parked on
credentials only an out-of-band ``hermes mcp login`` can replace re-fails on
every wake, so its detail is logged once per parked episode instead of once per
probe, and the message describes the re-probe rather than promising a wait for a
credential change the park does not implement.
"""

import asyncio
import logging
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest


def test_revival_discovery_registers_tools_while_ready_is_cleared(monkeypatch):
    """A managed server revival must publish tools before readiness is reset."""
    from tools import mcp_tool
    from tools import mcp_tool_registration as _mcp_registration
    from tools.mcp_tool import MCPServerTask

    server = MCPServerTask("srv")
    server._config = {"url": "https://example.test/mcp"}
    server.session = SimpleNamespace(
        list_tools=AsyncMock(
            return_value=SimpleNamespace(
                tools=[SimpleNamespace(name="send_message")],
            )
        )
    )
    server._ready.clear()
    server._registered_tool_names = []
    monkeypatch.setitem(mcp_tool._servers, server.name, server)

    register = MagicMock(return_value=["srv__send_message"])
    monkeypatch.setattr(_mcp_registration, "_register_server_tools", register)

    asyncio.run(server._discover_tools())

    register.assert_called_once_with(server.name, server, server._config)
    assert server._registered_tool_names == ["srv__send_message"]


@pytest.mark.no_isolate
def test_parked_server_self_probes_and_revives(monkeypatch, tmp_path):
    """A parked server must revive on its own once the backend recovers,
    without any explicit _reconnect_event.set()."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))

    from tools import mcp_tool
    from tools.mcp_tool import MCPServerTask

    monkeypatch.setattr(mcp_tool, "_MAX_RECONNECT_RETRIES", 1)
    # Keep the self-probe cadence tiny so the test is fast.
    monkeypatch.setattr(mcp_tool, "_PARKED_RETRY_INTERVAL", 0.05)

    _real_sleep = asyncio.sleep

    async def _fast_sleep(_delay, *a, **kw):
        await _real_sleep(0)

    monkeypatch.setattr(mcp_tool.asyncio, "sleep", _fast_sleep)

    state = {
        "transport_calls": 0,
        "deregistered": 0,
        "backend_up": False,
        "revived_registration": 0,
    }

    async def _scenario():
        class _Task(MCPServerTask):
            def _is_http(self):
                return False

            def _deregister_tools(self):
                state["deregistered"] += 1
                self._registered_tool_names = []

            def _register_discovered_tools_if_needed(self):
                if self._ready.is_set() and not self._registered_tool_names:
                    state["revived_registration"] += 1
                    self._registered_tool_names = ["srv__tool"]

            async def _run_stdio(self, config):
                state["transport_calls"] += 1
                if state["transport_calls"] == 1:
                    # First connect succeeds (sets _ready), then dies.
                    self.session = object()
                    self._ready.set()
                    self._ever_connected = True
                    self.session = None
                    raise RuntimeError("backend outage begins")
                if not state["backend_up"]:
                    raise RuntimeError("backend still down")
                # Backend recovered: establish a session and park in the
                # lifecycle wait like the real transport does.
                self.session = object()
                self._register_discovered_tools_if_needed()
                await self._wait_for_lifecycle_event()

        task = _Task("srv")
        task._registered_tool_names = ["srv__tool"]

        run_task = asyncio.ensure_future(task.run({"command": "x"}))

        # Let it exhaust the budget (1 retry) and park.
        for _ in range(2000):
            await _real_sleep(0)
            if state["deregistered"] >= 1:
                break
        assert state["deregistered"] >= 1, "server never parked"
        assert not run_task.done(), "run task exited instead of parking"

        # The backend comes back. NOTHING sets _reconnect_event — revival
        # must come from the timed self-probe alone.
        state["backend_up"] = True
        for _ in range(200):
            await _real_sleep(0.01)
            if task.session is not None:
                break

        assert task.session is not None, (
            "parked server never self-probed back to life "
            f"(transport_calls={state['transport_calls']})"
        )
        assert state["revived_registration"] >= 1, (
            "revived server did not re-register its tools"
        )

        task._shutdown_event.set()
        task._reconnect_event.set()
        try:
            await asyncio.wait_for(run_task, timeout=15)
        except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
            run_task.cancel()

    asyncio.run(_scenario())


# ── Parked-auth log hygiene (#337) ───────────────────────────────────────────

def _auth_park_task(monkeypatch, name="authless"):
    """A task whose transport fails the initial connect with an auth error.

    Flip ``state["auth_ok"]`` to let the next probe establish a session. Returns
    ``(task, state)``; ``state["parked"]`` counts parks.
    """
    from tools import mcp_tool
    from tools.mcp_oauth import OAuthNonInteractiveError
    from tools.mcp_tool import MCPServerTask

    state = {"transport_calls": 0, "parked": 0, "auth_ok": False}

    class _Task(MCPServerTask):
        def _is_http(self):
            return False

        def _deregister_tools(self):
            state["parked"] += 1
            self._registered_tool_names = []

        async def _negotiate_session(self, session, connect_timeout):
            return object()

        async def _discover_tools(self):
            self._registered_tool_names = [f"{self.name}__tool"]

        async def _run_stdio(self, config):
            state["transport_calls"] += 1
            if not state["auth_ok"]:
                raise OAuthNonInteractiveError(
                    "Browser authorization is required. Run `hermes mcp login <server>` "
                    "interactively to (re)authorize, then restart or reload the gateway.")
            # Real _serve_session: only the handshake and discovery are stubbed, so the episode
            # reset stays the production one rather than something the test re-implements.
            return await self._serve_session(object(), 5.0)

    # Self-probe as fast as the loop allows so the test does not wait 300s.
    monkeypatch.setattr(mcp_tool, "_PARKED_RETRY_INTERVAL", 0.01)
    return _Task(name), state


async def _spin_until(predicate, timeout=10.0):
    """Drive the loop until ``predicate()``; False on timeout."""
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        await asyncio.sleep(0)
        if predicate():
            return True
    return False


async def _stop(task, run_task):
    task._shutdown_event.set()
    task._reconnect_event.set()
    try:
        await asyncio.wait_for(run_task, timeout=15)
    except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
        run_task.cancel()


def _park_logs(caplog):
    """Every park log naming the auth failure, in order."""
    return [r for r in caplog.records
            if "parking" in r.getMessage() and "OAuthNonInteractiveError" in r.getMessage()]


@pytest.mark.no_isolate
def test_auth_parked_server_logs_its_detail_once_per_episode(monkeypatch, tmp_path, caplog):
    """The self-probe re-fails forever; only the episode's first failure is a WARNING."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))

    async def _scenario():
        task, state = _auth_park_task(monkeypatch)
        with caplog.at_level(logging.DEBUG, logger="tools.mcp_tool"):
            run_task = asyncio.ensure_future(task.run({"command": "x"}))
            assert await _spin_until(lambda: state["parked"] >= 3), (
                f"server did not re-probe (parks={state['parked']})")
            await _stop(task, run_task)

    asyncio.run(_scenario())

    records = _park_logs(caplog)
    assert len(records) >= 3, f"expected one park log per probe, got {len(records)}"
    warnings = [r for r in records if r.levelno == logging.WARNING]
    assert len(warnings) == 1, (
        f"an auth-parked server must log its detail once per episode, got {len(warnings)} WARNINGs")
    assert all(r.levelno == logging.DEBUG for r in records if r is not warnings[0]), (
        "repeat parked-auth logs must be DEBUG, got: " + str({r.levelname for r in records}))
    assert all(r.exc_info is None for r in records), "parked-auth logs must not carry a traceback"


@pytest.mark.no_isolate
def test_auth_park_after_a_real_session_logs_again(monkeypatch, tmp_path, caplog):
    """The dedup is per episode: a server that connects and then loses auth warns again."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))

    async def _scenario():
        task, state = _auth_park_task(monkeypatch)
        with caplog.at_level(logging.DEBUG, logger="tools.mcp_tool"):
            run_task = asyncio.ensure_future(task.run({"command": "x"}))
            assert await _spin_until(lambda: state["parked"] >= 2), "never re-probed"
            # Credentials arrive out of band; the next self-probe connects.
            state["auth_ok"] = True
            assert await _spin_until(lambda: task.session is not None), "never revived"
            # ...and are revoked again.
            state["auth_ok"] = False
            parked_before = state["parked"]
            task._reconnect_event.set()
            assert await _spin_until(lambda: state["parked"] > parked_before), "never re-parked"
            await _stop(task, run_task)

    asyncio.run(_scenario())

    warnings = [r for r in _park_logs(caplog) if r.levelno == logging.WARNING]
    assert len(warnings) == 2, (
        f"a new auth failure after a real session must warn again, got {len(warnings)}")


@pytest.mark.no_isolate
def test_auth_park_message_states_the_probe_interval(monkeypatch, tmp_path, caplog):
    """The message must describe the timed re-probe, not a credential-change wait it never does."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    from tools import mcp_tool

    async def _scenario():
        task, state = _auth_park_task(monkeypatch, name="needs-login")
        with caplog.at_level(logging.DEBUG, logger="tools.mcp_tool"):
            run_task = asyncio.ensure_future(task.run({"command": "x"}))
            assert await _spin_until(lambda: state["parked"] >= 1), "never parked"
            await _stop(task, run_task)

    asyncio.run(_scenario())

    message = _park_logs(caplog)[0].getMessage()
    assert f"re-probing every {mcp_tool._PARKED_RETRY_INTERVAL}s" in message, message
    assert "hermes mcp login needs-login" in message, message
    assert "parking until credentials change" not in message, (
        "the park is timed, so the message must not promise a wait for a credential change")
