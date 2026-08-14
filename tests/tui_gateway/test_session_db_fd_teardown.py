"""Regression coverage for profile-scoped SessionDB ownership at teardown."""

from __future__ import annotations

import threading
from pathlib import Path

import psutil

from hermes_cli import sqlite_safe_read
from hermes_state import SessionDB
from run_agent import AIAgent
from tui_gateway import server


def _tracked_connections(path: Path) -> int:
    key = str(path.resolve())
    with sqlite_safe_read._live_lock:
        return sqlite_safe_read._live_connections.get(key, 0)


def _sqlite_fds(path: Path) -> int:
    sqlite_paths = {
        str(path.resolve()),
        str(path.with_name(f"{path.name}-wal").resolve()),
        str(path.with_name(f"{path.name}-shm").resolve()),
    }
    return sum(
        1
        for opened in psutil.Process().open_files()
        if str(Path(opened.path).resolve()) in sqlite_paths
    )


def _bare_agent(db: SessionDB, session_id: str) -> AIAgent:
    agent = object.__new__(AIAgent)
    agent.session_id = session_id
    agent._session_db = db
    agent._session_db_created = True
    agent._owns_session_db = False
    agent._end_session_on_close = True
    agent._active_children = []
    agent._active_children_lock = threading.Lock()
    agent.client = None
    agent._session_messages = []
    agent.commit_memory_session = lambda *_args, **_kwargs: None
    return agent


def test_profile_session_teardown_keeps_sqlite_fds_flat(tmp_path):
    """Fifty profile session lifecycles must not retain state.db handles."""
    db_path = tmp_path / "state.db"
    baseline_tracked = _tracked_connections(db_path)
    baseline_fds = _sqlite_fds(db_path)
    opened: list[SessionDB] = []

    try:
        for cycle in range(50):
            session_id = f"fd-cycle-{cycle}"
            db = SessionDB(db_path=db_path)
            opened.append(db)
            db.create_session(session_id=session_id, source="desktop")
            assert db.get_session(session_id)["id"] == session_id
            agent = _bare_agent(db, session_id)
            assert server._transfer_db_to_agent(agent, db) is True

            server._teardown_session(
                {
                    "agent": agent,
                    "history": [],
                    "history_lock": threading.Lock(),
                    "profile_home": str(tmp_path),
                    "session_key": session_id,
                }
            )

        final_tracked = _tracked_connections(db_path)
        final_fds = _sqlite_fds(db_path)
    finally:
        # Keep a failing bite isolated from later tests on the same worker.
        for db in opened:
            db.close()

    assert final_tracked <= baseline_tracked + 1, (
        f"tracked state.db connections grew {baseline_tracked} -> {final_tracked}; "
        f"open SQLite fds grew {baseline_fds} -> {final_fds}"
    )
    assert final_fds <= baseline_fds + 3, (
        f"open SQLite fds grew {baseline_fds} -> {final_fds}; "
        f"tracked connections grew {baseline_tracked} -> {final_tracked}"
    )


def test_agent_close_does_not_close_borrowed_shared_db(tmp_path):
    """The launch-profile handle outlives any one agent."""
    db_path = tmp_path / "state.db"
    db = SessionDB(db_path=db_path)
    agent = _bare_agent(db, "shared-session")
    db.create_session(session_id=agent.session_id, source="desktop")

    try:
        agent.close()
        assert _tracked_connections(db_path) >= 1
        assert db.get_session(agent.session_id)["id"] == agent.session_id
    finally:
        db.close()


def test_teardown_closes_owned_db_when_agent_close_is_a_noop(tmp_path):
    """Synthetic agents still release a transferred profile handle."""
    db_path = tmp_path / "state.db"
    db = SessionDB(db_path=db_path)

    class NoOpAgent:
        session_id = "synthetic-session"
        model = "synthetic"
        platform = "desktop"
        _session_db = None

        def close(self):
            pass

    agent = NoOpAgent()
    assert server._transfer_db_to_agent(agent, db) is True

    server._teardown_session(
        {
            "agent": agent,
            "history": [],
            "history_lock": threading.Lock(),
            "profile_home": str(tmp_path),
            "session_key": agent.session_id,
        }
    )

    assert _tracked_connections(db_path) == 0
