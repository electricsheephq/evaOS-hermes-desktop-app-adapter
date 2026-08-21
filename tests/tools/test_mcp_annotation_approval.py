"""Profile-isolation regressions for stable Hermes' native MCP trust gate."""

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

import tools.mcp_tool as mcp
from hermes_constants import reset_hermes_home_override, set_hermes_home_override


@contextmanager
def _scope(home):
    token = set_hermes_home_override(home)
    try:
        yield
    finally:
        reset_hermes_home_override(token)


def _clear_trust_state():
    mcp._server_trust_levels._by_scope.clear()
    mcp._tool_read_only_hints._by_scope.clear()


def test_native_trust_gate_fails_closed_for_a_sibling_profiles_server(tmp_path):
    profile_a = tmp_path / "profile-a"
    profile_b = tmp_path / "profile-b"
    profile_a.mkdir()
    profile_b.mkdir()
    _clear_trust_state()
    try:
        with _scope(profile_a):
            mcp._record_tool_trust_metadata(
                "mail",
                {"trust": "untrusted"},
                [SimpleNamespace(name="send", annotations=None)],
            )

        with _scope(profile_b), patch(
            "tools.approval.request_elicitation_consent", return_value="deny"
        ):
            result = mcp._trust_gate_check("mail", "send")

        assert result is not None
        assert "NOT run" in result
    finally:
        _clear_trust_state()


def test_same_server_name_keeps_each_profiles_own_trust_policy(tmp_path):
    profile_a = tmp_path / "profile-a"
    profile_b = tmp_path / "profile-b"
    profile_a.mkdir()
    profile_b.mkdir()
    _clear_trust_state()
    try:
        with _scope(profile_a):
            mcp._record_tool_trust_metadata(
                "mail", {"trust": "full"}, [SimpleNamespace(name="send")]
            )
            assert mcp._trust_gate_check("mail", "send") is None

        with _scope(profile_b):
            mcp._record_tool_trust_metadata(
                "mail",
                {"trust": "untrusted"},
                [SimpleNamespace(name="send", annotations=None)],
            )
            with patch(
                "tools.approval.request_elicitation_consent", return_value="deny"
            ):
                assert mcp._trust_gate_check("mail", "send") is not None
    finally:
        _clear_trust_state()
