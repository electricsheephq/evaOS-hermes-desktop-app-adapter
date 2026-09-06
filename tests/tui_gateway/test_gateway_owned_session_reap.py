"""Tests for #60609: the TUI backend must not end gateway-owned sessions.

``_finalize_session`` (and thus the ws-orphan reaper / session.close paths
that funnel into it) marks the session ended in state.db.  For sessions the
messaging gateway owns (telegram, discord, ...), that write creates the
Groundhog Day routing loop described in #60609 — the gateway self-heal
drops the ended-but-routed entry, recovers hours-old parent context, and
loops.  The TUI is only a viewer of those sessions.
"""

import sqlite3
import threading
from unittest.mock import MagicMock, patch

from tui_gateway.server import _finalize_session, _is_gateway_owned_source, _teardown_session


class TestIsGatewayOwnedSource:
    def test_builtin_gateway_platforms_are_owned(self):
        for src in ("telegram", "discord", "whatsapp", "slack", "signal",
                    "matrix", "mattermost", "bluebubbles", "sms", "email"):
            assert _is_gateway_owned_source(src) is True, src

    def test_case_and_whitespace_normalized(self):
        assert _is_gateway_owned_source(" Telegram ") is True

    def test_tui_owned_sources_are_not(self):
        for src in ("tui", "cli", "webui", "desktop", "cron", "subagent",
                    "test", "acp", ""):
            assert _is_gateway_owned_source(src) is False, src

    def test_local_and_server_endpoints_are_not(self):
        # Platform enum members, but their sessions aren't owned by a remote
        # chat surface — reaping them keeps /resume clean.
        for src in ("local", "webhook", "api_server", "msgraph_webhook"):
            assert _is_gateway_owned_source(src) is False, src

    def test_arbitrary_strings_are_not(self):
        assert _is_gateway_owned_source("hermesbench-task-xyz") is False
        assert _is_gateway_owned_source(None) is False


def _make_session(session_id="sess_1"):
    agent = MagicMock()
    agent.session_id = session_id
    return {
        "agent": agent,
        "history": [{"role": "user", "content": "x"}],
        "history_lock": None,
        "session_key": session_id,
    }


def _make_real_session(tmp_path, monkeypatch, *, source, session_id):
    from hermes_state import SessionDB
    from run_agent import AIAgent

    hermes_home = tmp_path / "hermes_home"
    hermes_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    db_path = hermes_home / "state.db"
    db = SessionDB(db_path=db_path)
    db.create_session(session_id, source=source)

    # Bypass provider construction while still exercising the production
    # AIAgent.close() implementation against a real SessionDB handle.
    agent = AIAgent.__new__(AIAgent)
    agent.session_id = session_id
    agent._session_db = db
    agent._owns_session_db = True
    agent._end_session_on_close = True
    agent._session_messages = []
    agent._active_children_lock = threading.Lock()
    agent._active_children = []

    session = _make_session(session_id)
    session["agent"] = agent
    session["profile_home"] = str(hermes_home)
    return db, db_path, session, agent


def _read_real_row(db_path, session_id):
    from hermes_state import SessionDB

    db = SessionDB(db_path=db_path)
    try:
        return db.get_session(session_id)
    finally:
        db.close()


class TestFinalizeSkipsGatewaySessions:
    @patch("tui_gateway.server._get_db")
    def test_gateway_session_not_ended(self, mock_get_db):
        db = MagicMock()
        db.get_session.return_value = {"id": "sess_1", "source": "telegram"}
        mock_get_db.return_value = db

        _finalize_session(_make_session(), end_reason="ws_orphan_reap")

        db.end_session.assert_not_called()


    @patch("tui_gateway.server._get_db")
    def test_missing_row_still_ended(self, mock_get_db):
        """A session with no state.db row can't be gateway-owned — keep the
        pre-existing reap behavior."""
        db = MagicMock()
        db.get_session.return_value = None
        mock_get_db.return_value = db

        _finalize_session(_make_session(), end_reason="tui_close")

        db.end_session.assert_called_once_with("sess_1", "tui_close")


class _SessionClosingAgent:
    """Small close seam matching AIAgent's row-ending close policy."""

    def __init__(self, db, session_id="sess_1"):
        self.db = db
        self.session_id = session_id
        self._end_session_on_close = True

    def close(self):
        if self._end_session_on_close:
            self.db.end_session(self.session_id, "agent_close")


class TestTeardownPreservesGatewaySessions:
    @patch("tui_gateway.server._get_db")
    def test_gateway_session_close_does_not_end_row(self, mock_get_db):
        db = MagicMock()
        db.get_session.return_value = {"id": "sess_1", "source": "telegram"}
        mock_get_db.return_value = db
        agent = _SessionClosingAgent(db)
        session = _make_session()
        session["agent"] = agent

        _teardown_session(session, end_reason="ws_orphan_reap")

        db.end_session.assert_not_called()
        assert agent._end_session_on_close is False

    @patch("tui_gateway.server._get_db")
    def test_non_gateway_session_keeps_close_end_policy(self, mock_get_db):
        db = MagicMock()
        db.get_session.return_value = {"id": "sess_1", "source": "tui"}
        mock_get_db.return_value = db
        agent = _SessionClosingAgent(db)
        session = _make_session()
        session["agent"] = agent

        _teardown_session(session, end_reason="tui_close")

        assert agent._end_session_on_close is True
        assert db.end_session.call_args_list[-1].args == ("sess_1", "agent_close")


class TestRealSessionDBTeardown:
    def test_gateway_row_survives_real_agent_close(self, tmp_path, monkeypatch):
        _db, db_path, session, agent = _make_real_session(
            tmp_path,
            monkeypatch,
            source="telegram",
            session_id="real-gateway-session",
        )

        _teardown_session(session, end_reason="ws_orphan_reap")

        row = _read_real_row(db_path, "real-gateway-session")
        assert row["source"] == "telegram"
        assert row["ended_at"] is None
        assert row["end_reason"] is None
        assert agent._end_session_on_close is False

    def test_non_gateway_row_ends_before_real_agent_close(self, tmp_path, monkeypatch):
        _db, db_path, session, agent = _make_real_session(
            tmp_path,
            monkeypatch,
            source="tui",
            session_id="real-tui-session",
        )

        _teardown_session(session, end_reason="tui_close")

        row = _read_real_row(db_path, "real-tui-session")
        assert row["source"] == "tui"
        assert row["ended_at"] is not None
        assert row["end_reason"] == "tui_close"
        assert agent._end_session_on_close is True

    def test_lookup_failure_falls_back_to_agent_db_before_real_close(
        self, tmp_path, monkeypatch
    ):
        _db, db_path, session, agent = _make_real_session(
            tmp_path,
            monkeypatch,
            source="telegram",
            session_id="real-lookup-failure-session",
        )
        from hermes_state import SessionDB

        original_get_session = SessionDB.get_session
        calls = []

        def fail_first_lookup(handle, session_id):
            calls.append(handle)
            if len(calls) == 1:
                raise sqlite3.OperationalError("database is locked")
            return original_get_session(handle, session_id)

        with patch.object(SessionDB, "get_session", fail_first_lookup):
            _teardown_session(session, end_reason="ws_orphan_reap")

        assert len(calls) == 2
        assert calls[0] is not agent._session_db
        assert calls[1] is agent._session_db
        row = _read_real_row(db_path, "real-lookup-failure-session")
        assert row["source"] == "telegram"
        assert row["ended_at"] is None
        assert row["end_reason"] is None
        assert agent._end_session_on_close is False
