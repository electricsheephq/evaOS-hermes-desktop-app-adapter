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

import pytest

from tui_gateway.server import _is_gateway_owned_source, _teardown_session


class TestIsGatewayOwnedSource:
    def test_builtin_gateway_platforms_are_owned(self):
        for src in ("telegram", "discord", "whatsapp", "slack", "signal",
                    "matrix", "mattermost", "bluebubbles", "sms", "email"):
            assert _is_gateway_owned_source(src) is True, src


    def test_tui_owned_sources_are_not(self):
        for src in ("tui", "cli", "webui", "desktop", "cron", "subagent",
                    "test", "acp", ""):
            assert _is_gateway_owned_source(src) is False, src




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

    # Exercise the production close path without constructing a model provider.
    agent = AIAgent.__new__(AIAgent)
    agent.session_id = session_id
    agent._session_db = db
    agent._owns_session_db = True
    agent._end_session_on_close = True
    agent._session_messages = []
    agent._active_children_lock = threading.Lock()
    agent._active_children = []
    agent._memory_manager = None  # close() reads it directly; a stub must not rely on _quietly swallowing

    session = _make_session(session_id)
    session["agent"] = agent
    session["profile_home"] = str(hermes_home)
    session["source"] = source
    return db_path, session, agent


def _read_real_row(db_path, session_id):
    from hermes_state import SessionDB

    db = SessionDB(db_path=db_path)
    try:
        return db.get_session(session_id)
    finally:
        db.close()




class TestGatewayOwnedSessionTeardown:
    def test_viewer_teardown_leaves_gateway_owned_row_open(self, tmp_path, monkeypatch):
        session_id = "gateway-owned-session"
        db_path, session, agent = _make_real_session(
            tmp_path, monkeypatch, source="telegram", session_id=session_id
        )

        _teardown_session(session, end_reason="ws_orphan_reap")

        row = _read_real_row(db_path, session_id)
        assert row["ended_at"] is None
        assert row["end_reason"] is None
        assert agent._end_session_on_close is False
        assert agent._owns_session_db is False  # close() reached _finalize_owned_session_row


class TestDesktopAutomaticReclaimTeardown:
    """#105588: automatic Desktop cleanup reclaims runtime but leaves the durable row open THROUGH the full
    teardown — ``_finalize_session`` skipping ``end_session`` is not enough, ``agent.close()`` ends the row
    as ``agent_close`` unless the spare decision reaches the agent."""

    @pytest.mark.parametrize("reason", ["ws_orphan_reap", "idle_timeout", "lru_evict"])
    def test_automatic_reclaim_leaves_desktop_row_open(self, tmp_path, monkeypatch, reason):
        db_path, session, agent = _make_real_session(
            tmp_path, monkeypatch, source="desktop", session_id=f"desktop-{reason}"
        )

        _teardown_session(session, end_reason=reason)

        row = _read_real_row(db_path, f"desktop-{reason}")
        assert (row["ended_at"], row["end_reason"]) == (None, None)
        assert agent._end_session_on_close is False
        assert agent._owns_session_db is False  # close() reached _finalize_owned_session_row

    @pytest.mark.parametrize("source,reason", [("desktop", "tui_close"), ("tui", "ws_orphan_reap")])
    def test_explicit_close_and_non_desktop_reap_still_end_row(self, tmp_path, monkeypatch, source, reason):
        db_path, session, agent = _make_real_session(
            tmp_path, monkeypatch, source=source, session_id=f"{source}-{reason}"
        )

        _teardown_session(session, end_reason=reason)

        row = _read_real_row(db_path, f"{source}-{reason}")
        assert row["ended_at"] is not None
        assert row["end_reason"] == reason
        assert agent._end_session_on_close is True  # flag untouched when the row was ended here


class TestRealSessionDBTeardown:
    """#261: an unavailable profile-scoped lookup handle must not hand ownership of the row to
    ``AIAgent.close()``; the agent's own handle qualifies it, and when both fail the close is spared."""

    def test_lookup_failure_falls_back_to_agent_db_before_real_close(self, tmp_path, monkeypatch):
        db_path, session, agent = _make_real_session(
            tmp_path,
            monkeypatch,
            source="telegram",
            session_id="real-lookup-failure-session",
        )
        from hermes_state import SessionDB

        agent_db = agent._session_db
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
        assert calls[0] is not agent_db
        assert calls[1] is agent_db
        row = _read_real_row(db_path, "real-lookup-failure-session")
        assert row["source"] == "telegram"
        assert row["ended_at"] is None
        assert row["end_reason"] is None
        assert agent._end_session_on_close is False

    def test_both_lookup_failures_disable_agent_close(self, tmp_path, monkeypatch):
        db_path, session, agent = _make_real_session(
            tmp_path,
            monkeypatch,
            source="telegram",
            session_id="real-both-lookup-failure-session",
        )
        from hermes_state import SessionDB

        def fail_lookup(_handle, _session_id):
            raise sqlite3.OperationalError("database is locked")

        with patch.object(SessionDB, "get_session", fail_lookup):
            _teardown_session(session, end_reason="ws_orphan_reap")

        row = _read_real_row(db_path, "real-both-lookup-failure-session")
        assert row["source"] == "telegram"
        assert row["ended_at"] is None
        assert row["end_reason"] is None
        assert agent._end_session_on_close is False
