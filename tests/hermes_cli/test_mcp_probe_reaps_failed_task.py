"""A failed ``_probe_single_server`` must not leave its MCPServerTask running.

The probe claims the task it connects (to read ``initialize_result``), and a claim tells
``_connect_server`` that someone else owns the task, so the connect no longer reaps it on
failure. The probe never shut it down either: every failed probe left a parked task that
self-probed every ``_PARKED_RETRY_INTERVAL`` for the life of the process, and each Desktop
sweep added another.

The MCP loop is kept alive while these tests assert. ``_stop_mcp_loop_if_idle`` would
otherwise drain every pending task after the probe (no registered server owns the loop in a
test process), which hides the leak that a live gateway keeps.
"""

import asyncio
import time
from types import SimpleNamespace

import pytest

from tests.tools.test_mcp_initial_connect_shutdown import _cleanup_mcp_state, _reset_mcp_state

_PROBES = 5  # one probe per Desktop session sweeping the same failing server


async def _pending_tasks():
    current = asyncio.current_task()
    return sorted(
        getattr(task.get_coro(), "__qualname__", repr(task))
        for task in asyncio.all_tasks()
        if task is not current and not task.done()
    )


def _transient():
    return ConnectionError("probe target unavailable")


def _auth():
    from tools.mcp_oauth import OAuthNonInteractiveError

    return OAuthNonInteractiveError("MCP OAuth requires browser authorization")


@pytest.fixture
def failing_probe_env(monkeypatch, tmp_path):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))

    from tools import mcp_tool
    from tools import mcp_tool_config as _config
    from tools import mcp_tool_lifecycle as _lifecycle
    from tools import mcp_tool_loop as _loop

    _reset_mcp_state(mcp_tool)
    state = SimpleNamespace(created=[], runs=0, error=_transient, baseline=None)

    class _FailingServerTask(mcp_tool.MCPServerTask):
        def __init__(self, name):
            super().__init__(name)
            state.created.append(self)

        async def _run_stdio(self, config):
            state.runs += 1
            raise state.error()

    real_sleep = asyncio.sleep

    async def _fast_sleep(_delay, *a, **kw):
        await real_sleep(0)

    monkeypatch.setattr(mcp_tool, "MCPServerTask", _FailingServerTask)
    monkeypatch.setattr(mcp_tool, "_MCP_AVAILABLE", True)
    monkeypatch.setattr(mcp_tool, "_MAX_INITIAL_CONNECT_RETRIES", 1)
    monkeypatch.setattr(mcp_tool, "_PARKED_RETRY_INTERVAL", 0.05)
    monkeypatch.setattr(mcp_tool.asyncio, "sleep", _fast_sleep)
    # The entry stays configured and enabled, so a leaked parked task keeps self-probing.
    monkeypatch.setattr(_config, "_load_mcp_config", lambda: {"flaky": {"command": "x"}})
    # Keep the loop alive during the asserts (see the module docstring).
    monkeypatch.setattr(_lifecycle, "_stop_mcp_loop_if_idle", lambda: False)
    _loop._ensure_mcp_loop()
    state.baseline = _loop._run_on_mcp_loop(_pending_tasks, timeout=5)
    try:
        yield state
    finally:
        _cleanup_mcp_state(mcp_tool, state.created)


def _probe_k_times(state):
    from hermes_cli.mcp_config import _probe_single_server

    for _ in range(_PROBES):
        with pytest.raises(Exception):
            _probe_single_server("flaky", {"command": "x"}, connect_timeout=5, details={})


@pytest.mark.parametrize("error", [_transient, _auth], ids=["transient", "auth"])
def test_probe_single_server_reaps_failed_task(failing_probe_env, error):
    from tools import mcp_tool
    from tools.mcp_tool_loop import _run_on_mcp_loop

    state = failing_probe_env
    state.error = error
    _probe_k_times(state)

    assert len(state.created) == _PROBES
    assert [s._task.done() for s in state.created] == [True] * _PROBES, (
        "a failed probe left its MCP server task running (parked, self-probing)")
    assert _run_on_mcp_loop(_pending_tasks, timeout=5) == state.baseline
    with mcp_tool._lock:
        assert "flaky" not in mcp_tool._servers


@pytest.mark.parametrize(
    ("error", "attempts_per_probe"),
    # transient: 1 attempt + _MAX_INITIAL_CONNECT_RETRIES (1); auth: permanent, parks at once
    [(_transient, 2), (_auth, 1)], ids=["transient", "auth"])
def test_failed_probes_do_not_self_probe(failing_probe_env, error, attempts_per_probe):
    from tools import mcp_tool

    state = failing_probe_env
    state.error = error
    _probe_k_times(state)

    expected = _PROBES * attempts_per_probe
    assert state.runs == expected
    time.sleep(10 * mcp_tool._PARKED_RETRY_INTERVAL)
    assert state.runs == expected, (
        f"failed probes kept re-probing after they returned: {state.runs - expected} extra attempts")
