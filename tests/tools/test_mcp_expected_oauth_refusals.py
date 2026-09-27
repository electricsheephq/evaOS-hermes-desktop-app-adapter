"""Expected OAuth refusals are terminal, quiet and never retried as transient.

* A dashboard flow the user cancelled raises an auth-class error: the server parks at once
  instead of running the transient 1/2/4 s ladder against a flow that can never complete.
* A parked task's unattended self-probe never publishes to a dashboard flow it inherited; it
  fails fast as non-interactive.
* The SDK's ``logger.exception("OAuth flow error")`` for those refusals is demoted to DEBUG
  without a traceback; Hermes' own park WARNING is the single user-facing line.
* The transient park line describes the timed re-probe it actually performs.
"""

import asyncio
import logging
from unittest.mock import AsyncMock

import pytest

_URL = "https://mcp.example.test/mcp"
_AUTHORIZE = "https://as.example.test/authorize?state=s"


def _flow(tmp_path, *, cancelled):
    from tools.mcp_dashboard_oauth import DashboardOAuthFlow

    flow = DashboardOAuthFlow(flow_id="f1", server_name="srv", profile=None,
                              hermes_home=str(tmp_path), redirect_uri="https://dash.example.test/cb")
    if cancelled:
        flow.mark_error("OAuth cancelled by user", cancelled=True)
    return flow


def _fast_parked_loop(monkeypatch, config):
    from tools import mcp_tool
    from tools import mcp_tool_config as _config

    monkeypatch.setattr(mcp_tool, "_MAX_INITIAL_CONNECT_RETRIES", 3)
    monkeypatch.setattr(mcp_tool, "_PARKED_RETRY_INTERVAL", 0.05)
    monkeypatch.setattr(_config, "_load_mcp_config", lambda: {"srv": config})
    real_sleep = asyncio.sleep

    async def _fast_sleep(_delay, *a, **kw):
        await real_sleep(0)

    monkeypatch.setattr(mcp_tool.asyncio, "sleep", _fast_sleep)
    return real_sleep


def _run_until(task_cls, config, flow, done, real_sleep):
    """Run a registered-style server task under *flow* until ``done()`` or ~4 s."""
    from tools.mcp_dashboard_oauth import dashboard_oauth_flow

    async def _scenario():
        task = task_cls("srv")
        with dashboard_oauth_flow(flow):
            run_task = asyncio.ensure_future(task.run(config))
        for _ in range(400):
            await real_sleep(0.01)
            if done():
                break
        await task.shutdown()
        await asyncio.wait_for(run_task, timeout=5)

    asyncio.run(_scenario())


@pytest.mark.no_isolate
def test_cancelled_dashboard_flow_is_terminal_auth_error(monkeypatch, tmp_path):
    from tools.mcp_dashboard_oauth import get_dashboard_oauth_flow
    from tools.mcp_tool import MCPServerTask
    from tools.mcp_tool_errors import _classify_mcp_failure

    flow = _flow(tmp_path, cancelled=True)
    with pytest.raises(RuntimeError, match="cancelled") as info:
        asyncio.run(flow.publish_authorization_url(_AUTHORIZE))
    assert _classify_mcp_failure(info.value) == "permanent"

    config = {"url": _URL, "auth": "oauth", "skip_preflight": True}
    real_sleep = _fast_parked_loop(monkeypatch, config)
    attempts: list = []
    attempts_at_park: list = []

    class _Task(MCPServerTask):
        def _deregister_tools(self):
            self._registered_tool_names = []

        async def _park(self, revival_reason):
            attempts_at_park.append(len(attempts))
            return await super()._park(revival_reason)

        async def _run_http(self, config):
            attempts.append(1)
            await get_dashboard_oauth_flow().publish_authorization_url(_AUTHORIZE)

    _run_until(_Task, config, flow, lambda: len(attempts_at_park) >= 4, real_sleep)

    assert len(attempts_at_park) >= 4, attempts_at_park
    per_episode = [b - a for a, b in zip([0] + attempts_at_park, attempts_at_park)]
    assert per_episode == [1] * len(per_episode), (
        f"a cancelled flow must park after ONE attempt per interval, got {per_episode}")


@pytest.mark.no_isolate
def test_self_probe_never_publishes_to_an_inherited_dashboard_flow(monkeypatch, tmp_path):
    from tools.mcp_oauth import OAuthNonInteractiveError, _make_redirect_handler
    from tools.mcp_tool import MCPServerTask

    flow = _flow(tmp_path, cancelled=False)
    publish = AsyncMock()
    monkeypatch.setattr(flow, "publish_authorization_url", publish)
    config = {"url": _URL, "auth": "oauth", "skip_preflight": True}
    real_sleep = _fast_parked_loop(monkeypatch, config)
    handler = _make_redirect_handler(0)
    outcomes: list = []

    class _Task(MCPServerTask):
        def _deregister_tools(self):
            self._registered_tool_names = []

        async def _run_http(self, config):
            try:
                await handler(_AUTHORIZE)
            except OAuthNonInteractiveError:
                outcomes.append("refused")
                raise
            outcomes.append("published")
            # The user never finished the attended flow.
            raise OAuthNonInteractiveError("no authorization code")

    _run_until(_Task, config, flow, lambda: len(outcomes) >= 4, real_sleep)

    assert outcomes[0] == "published", "the attended initial connect still uses the dashboard flow"
    assert len(outcomes) >= 4 and set(outcomes[1:]) == {"refused"}, (
        f"a timed self-probe published to the dashboard flow: {outcomes}")
    assert publish.await_count == 1


@pytest.mark.parametrize("refusal", ["non_interactive", "cancelled"])
def test_sdk_oauth_flow_error_demoted_for_expected_refusals(caplog, refusal):
    import tools.mcp_dashboard_oauth as dashboard
    import tools.mcp_oauth as oauth

    exc_type = oauth.OAuthNonInteractiveError if refusal == "non_interactive" else dashboard.OAuthFlowCancelled
    sdk_logger = logging.getLogger("mcp.client.auth.oauth2")
    with caplog.at_level(logging.DEBUG, logger="mcp.client.auth.oauth2"):
        try:
            raise exc_type("expected refusal")
        except exc_type:
            sdk_logger.exception("OAuth flow error")
    records = [r for r in caplog.records if r.name == "mcp.client.auth.oauth2"]
    assert len(records) == 1
    assert records[0].levelno == logging.DEBUG
    assert records[0].levelname == "DEBUG"
    assert records[0].exc_info is None


def test_sdk_oauth_flow_error_still_logged_for_real_failures(caplog):
    import tools.mcp_oauth  # noqa: F401 -- installs the filter

    sdk_logger = logging.getLogger("mcp.client.auth.oauth2")
    with caplog.at_level(logging.DEBUG, logger="mcp.client.auth.oauth2"):
        try:
            raise ValueError("token endpoint returned garbage")
        except ValueError:
            sdk_logger.exception("OAuth flow error")
    records = [r for r in caplog.records if r.name == "mcp.client.auth.oauth2"]
    assert len(records) == 1
    assert records[0].levelno == logging.ERROR
    assert records[0].exc_info is not None and records[0].exc_info[0] is ValueError


@pytest.mark.no_isolate
def test_transient_park_line_describes_the_timed_reprobe(monkeypatch, tmp_path, caplog):
    from tools import mcp_tool
    from tools.mcp_tool import MCPServerTask

    monkeypatch.setattr(mcp_tool, "_MAX_INITIAL_CONNECT_RETRIES", 0)
    monkeypatch.setattr(mcp_tool, "_PARKED_RETRY_INTERVAL", 3600)

    class _Task(MCPServerTask):
        def _is_http(self):
            return False

        def _deregister_tools(self):
            self._registered_tool_names = []

        async def _run_stdio(self, config):
            raise ConnectionError("addon not running")

    async def _scenario():
        task = _Task("srv")
        run_task = asyncio.ensure_future(task.run({"command": "x"}))
        await asyncio.wait_for(task._ready.wait(), timeout=5)
        await task.shutdown()
        await asyncio.wait_for(run_task, timeout=5)

    with caplog.at_level(logging.DEBUG, logger="tools.mcp_tool"):
        asyncio.run(_scenario())

    parks = [r.getMessage() for r in caplog.records if "failed initial connection after" in r.getMessage()]
    assert len(parks) == 1, parks
    assert "re-probing every 3600s" in parks[0], parks[0]
    assert "until a reconnect is requested" not in parks[0], parks[0]
