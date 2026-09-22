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

def _auth_park_task(monkeypatch, name="authless", exc_factory=None):
    """A task whose transport fails the initial connect with a permanent error.

    Defaults to an auth error; ``exc_factory`` swaps in any other permanent one.
    Flip ``state["auth_ok"]`` to let the next probe establish a session. Returns
    ``(task, state)``; ``state["parked"]`` counts parks.
    """
    from tools import mcp_tool
    from tools.mcp_oauth import OAuthNonInteractiveError
    from tools.mcp_tool import MCPServerTask

    state = {"transport_calls": 0, "parked": 0, "auth_ok": False}

    def _default_auth_error():
        return OAuthNonInteractiveError(
            "Browser authorization is required. Run `hermes mcp login <server>` "
            "interactively to (re)authorize, then restart or reload the gateway.")

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
                raise (exc_factory or _default_auth_error)()
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
    """Shut the run loop down. An unexpected exception from it FAILS the test: these tests are the
    regression proof for a long-lived loop, and swallowing its crash would show green while the
    server task dies in production."""
    task._shutdown_event.set()
    task._reconnect_event.set()
    try:
        await asyncio.wait_for(run_task, timeout=15)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        run_task.cancel()


def _park_logs(caplog, exc_name="OAuthNonInteractiveError"):
    """Every park log naming that failure, in order.

    Matched on the state transition, not the word "parking": the suspect path logs "…instead of
    parking (state: connected → suspect)" for the same exception, and counting that as a park
    inflates every assertion here.
    """
    return [r for r in caplog.records
            if "\u2192 parked)" in r.getMessage() and exc_name in r.getMessage()]



# ── The parked-episode log latch (#337) ──────────────────────────────────────
#
# Two invariants, each driven over every path that reaches the latch. The drivers below are
# helpers, not tests: each performs three probes of one permanent-failure class and returns that
# path's log records in order.

def _probe_permanent_park(monkeypatch, caplog, exc_factory=None, exc_name="OAuthNonInteractiveError"):
    """Three timed self-probes against a transport that always fails permanently."""
    task, state = _auth_park_task(monkeypatch, exc_factory=exc_factory)

    async def _scenario():
        with caplog.at_level(logging.DEBUG, logger="tools.mcp_tool"):
            run_task = asyncio.ensure_future(task.run({"command": "x"}))
            assert await _spin_until(lambda: state["parked"] >= 3), (
                f"server did not re-probe (parks={state['parked']})")
            await _stop(task, run_task)

    asyncio.run(_scenario())
    return _park_logs(caplog, exc_name)


def _probe_oauth_setup(monkeypatch, caplog):
    """Three probes whose transport rebuild fails before the park is even logged.

    An ``auth: oauth`` server with no usable cached tokens raises in ``_build_oauth_auth`` every
    time the timed probe rebuilds the transport. That warning fires BEFORE the park, on the same
    interval -- it is why #337 measured two WARNINGs per cycle, not one -- so it must follow the
    episode latch without claiming it.
    """
    from tools.mcp_tool import MCPServerTask

    task = MCPServerTask("oauthless")
    task._auth_type = "oauth"

    def _boom(*a, **k):
        raise RuntimeError("no cached tokens")

    monkeypatch.setattr("tools.mcp_oauth_manager.get_manager", _boom)

    with caplog.at_level(logging.DEBUG, logger="tools.mcp_tool"):
        for _ in range(3):
            with pytest.raises(RuntimeError):
                task._build_oauth_auth("https://example.invalid/mcp", {})
            # The park that follows each failure claims the latch the first time.
            task._claim_parked_log("OAuthPark")

    return [r for r in caplog.records if "MCP OAuth setup failed" in r.getMessage()]


def _bad_command():
    return FileNotFoundError(2, "No such file or directory", "does-not-exist")


_PARK_PATHS = (
    ("expired_credential", lambda mp, cl: _probe_permanent_park(mp, cl)),
    ("bad_command", lambda mp, cl: _probe_permanent_park(mp, cl, _bad_command, "FileNotFoundError")),
    ("oauth_setup", _probe_oauth_setup),
)


@pytest.mark.no_isolate
@pytest.mark.parametrize("driver", [p[1] for p in _PARK_PATHS], ids=[p[0] for p in _PARK_PATHS])
def test_a_parked_episode_logs_its_detail_once(driver, monkeypatch, tmp_path, caplog):
    """One WARNING per parked episode, on every path that reaches the latch (#337).

    The latch is on the PARK, not on one error class: every permanent failure re-probes on the
    same ``_PARKED_RETRY_INTERVAL`` -- an expired credential, a bad stdio command, an OAuth setup
    that cannot find tokens -- so each states its detail once and then repeats at DEBUG. Before
    the latch covered them all, each of these warned on every probe forever.
    """
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))

    records = driver(monkeypatch, caplog)

    assert len(records) >= 3, f"expected one log per probe, got {len(records)}"
    warnings = [r for r in records if r.levelno == logging.WARNING]
    assert len(warnings) == 1, (
        f"a parked server must log its detail once per episode, got {len(warnings)} WARNINGs")
    assert warnings[0] is records[0], "the episode's FIRST failure is the one that warns"
    assert all(r.levelno == logging.DEBUG for r in records[1:]), (
        "repeat logs must be DEBUG, got: " + str([r.levelname for r in records[1:]]))

    message = records[0].getMessage()
    if "\u2192 parked)" in message:
        assert all(r.exc_info is None for r in records), "parked logs must not carry a traceback"
        # The park is a timed re-probe, so the message must not promise a wait it never performs.
        assert "parking until credentials change" not in message, message
        assert "re-probing every" in message, message


@pytest.mark.no_isolate
def test_an_episode_ends_on_a_proven_session_or_a_changed_failure(monkeypatch, tmp_path, caplog):
    """What re-arms the latch: a PROVEN session, or a different blocker (#337).

    Both halves guard against hiding a real diagnosis. A handshake that drops moments later does
    not end the episode -- that is the flapping case the latch exists for -- so the reset hangs off
    ``_mark_session_proven`` (keepalive or a tool call). And after a login succeeds the next probe
    can hit a NEW blocker before any session is proven; a boolean latch would bury that actionable
    failure under the old episode, so the latch holds the failure's identity instead.
    """
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    from tools.mcp_tool import MCPServerTask

    # ── A proven session ends the episode ───────────────────────────────────
    task, state = _auth_park_task(monkeypatch)

    async def _scenario():
        with caplog.at_level(logging.DEBUG, logger="tools.mcp_tool"):
            run_task = asyncio.ensure_future(task.run({"command": "x"}))
            assert await _spin_until(lambda: state["parked"] >= 2), "never re-probed"
            # Credentials arrive out of band; the next self-probe connects.
            state["auth_ok"] = True
            assert await _spin_until(lambda: task.session is not None), "never revived"
            # Production proves a session on a keepalive or a tool call; do the same rather than
            # relying on the handshake, which deliberately no longer clears the latch.
            task._mark_session_proven()
            # ...and the credentials are revoked again.
            state["auth_ok"] = False
            parked_before = state["parked"]
            task._reconnect_event.set()
            assert await _spin_until(lambda: state["parked"] > parked_before), "never re-parked"
            await _stop(task, run_task)

    asyncio.run(_scenario())

    warnings = [r for r in _park_logs(caplog) if r.levelno == logging.WARNING]
    assert len(warnings) == 2, (
        f"a new failure after a PROVEN session must warn again, got {len(warnings)}")

    # ── A changed failure re-arms it without any session at all ─────────────
    class _Resp:
        def __init__(self, code):
            self.status_code = code

    class _HTTPish(Exception):
        def __init__(self, code):
            super().__init__(f"HTTP {code}")
            self.response = _Resp(code)

    keyed = MCPServerTask("changing")
    key = keyed._parked_log_key_for
    assert key(_HTTPish(401)) != key(_HTTPish(403)), "a 401 and a 403 are different episodes"
    assert key(FileNotFoundError(2, "no such file")) == "FileNotFoundError"

    first = key(_HTTPish(401))
    assert keyed._claim_parked_log(first) is True, "the episode's first failure logs"
    assert keyed._claim_parked_log(first) is False, "the same failure re-probing does not"
    assert keyed._claim_parked_log(key(_HTTPish(403))) is True, "a changed failure logs again"
    assert keyed._claim_parked_log(key(_HTTPish(403))) is False
    keyed._clear_parked_log()
    assert keyed._claim_parked_log(key(_HTTPish(403))) is True, "a proven session re-arms the latch"
