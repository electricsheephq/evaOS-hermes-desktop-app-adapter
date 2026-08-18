"""Profile-scoped MCP trust gating and annotation regressions."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tools import mcp_tool


def _tool(name, hint=...):
    annotations = None if hint is ... else SimpleNamespace(readOnlyHint=hint)
    return SimpleNamespace(name=name, annotations=annotations)


def _private_loop(coro_or_factory, timeout=30):
    del timeout
    coro = coro_or_factory() if callable(coro_or_factory) else coro_or_factory
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


@pytest.fixture(autouse=True)
def _isolate_trust_state():
    mcp_tool._server_trust_levels.clear_all()
    mcp_tool._tool_read_only_hints.clear_all()
    yield
    mcp_tool._server_trust_levels.clear_all()
    mcp_tool._tool_read_only_hints.clear_all()


def test_annotations_fail_closed_and_evaos_lease_defaults_untrusted():
    mcp_tool._record_tool_trust_metadata(
        "pipedream",
        {"auth": "evaos_lease"},
        [_tool("read", True), _tool("write", False), _tool("missing"), _tool("bad", "yes")],
    )
    assert mcp_tool._server_trust_levels["pipedream"] == "untrusted"
    assert mcp_tool._tool_read_only_hints["pipedream"] == {
        "read": True,
        "write": False,
        "missing": False,
        "bad": False,
    }


def test_read_only_bypasses_gate_and_write_denial_precedes_connect():
    mcp_tool._record_tool_trust_metadata(
        "pipedream", {"trust": "untrusted"}, [_tool("read", True), _tool("write", False)]
    )
    with patch("tools.approval.request_elicitation_consent") as consent:
        assert mcp_tool._trust_gate_check("pipedream", "read") is None
    consent.assert_not_called()

    connect = MagicMock()
    handler = mcp_tool._make_tool_handler("pipedream", "write", 5.0)
    with patch(
        "tools.approval.request_elicitation_consent", return_value="decline"
    ), patch("tools.mcp_tool._get_connected_server_for_call", connect):
        result = handler({"secret": "must-not-run"})
    connect.assert_not_called()
    assert "did not approve" in json.loads(result)["error"]


def test_approval_failure_is_fail_closed_and_never_renders_arguments():
    secret = "pdt_value_that_must_not_escape"
    captured = {}
    mcp_tool._record_tool_trust_metadata(
        "pipedream", {"auth": "evaos_lease"}, [_tool("write", False)]
    )

    def capture(message, description, **kwargs):
        captured.update(message=message, description=description, kwargs=kwargs)
        raise RuntimeError("approval unavailable")

    with patch("tools.approval.request_elicitation_consent", side_effect=capture):
        result = mcp_tool._make_tool_handler("pipedream", "write", 5.0)(
            {"Authorization": f"Bearer {secret}"}
        )
    assert "approval system was unavailable" in json.loads(result)["error"]
    assert secret not in json.dumps(captured)


def test_approved_write_invokes_rpc_once():
    result = SimpleNamespace(
        isError=False,
        structuredContent=None,
        content=[SimpleNamespace(type="text", text="ok")],
    )
    session = SimpleNamespace(call_tool=AsyncMock(return_value=result))
    server = SimpleNamespace(
        session=session,
        _rpc_lock=asyncio.Lock(),
        _pending_call_context=None,
    )
    mcp_tool._record_tool_trust_metadata(
        "pipedream", {"auth": "evaos_lease"}, [_tool("write", False)]
    )
    handler = mcp_tool._make_tool_handler("pipedream", "write", 5.0)
    with patch(
        "tools.approval.request_elicitation_consent", return_value="accept"
    ), patch(
        "tools.mcp_tool._get_connected_server_for_call", return_value=server
    ), patch("tools.mcp_tool._run_on_mcp_loop", side_effect=_private_loop):
        rendered = handler({"row": 7})
    session.call_tool.assert_awaited_once_with("write", arguments={"row": 7})
    assert json.loads(rendered) == {"result": "ok"}


def test_trust_metadata_is_isolated_for_equal_profile_server_names(
    tmp_path, monkeypatch
):
    from agent import secret_scope
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override

    monkeypatch.setattr(secret_scope, "_MULTIPLEX_ACTIVE", True)
    homes = [tmp_path / "jane", tmp_path / "louis"]
    for index, home in enumerate(homes):
        token = set_hermes_home_override(home)
        try:
            mcp_tool._record_tool_trust_metadata(
                "pipedream",
                {"trust": "untrusted" if index == 0 else "full"},
                [_tool("rows", index == 0)],
            )
        finally:
            reset_hermes_home_override(token)

    for index, home in enumerate(homes):
        token = set_hermes_home_override(home)
        try:
            assert mcp_tool._server_trust_levels["pipedream"] == (
                "untrusted" if index == 0 else "full"
            )
            assert mcp_tool._tool_read_only_hints["pipedream"] == {
                "rows": index == 0
            }
        finally:
            reset_hermes_home_override(token)
