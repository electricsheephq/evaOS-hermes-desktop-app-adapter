"""Regression coverage for profile-scoped SessionDB ownership at teardown."""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

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
    agent._context_engine_shutdown_lock = threading.Lock()
    agent._context_engine_shutdown = False
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


def test_rpc_pool_session_list_releases_shared_db_reader(monkeypatch, tmp_path):
    """A reusable RPC worker must not retain the launch-profile WAL reader."""
    db_path = tmp_path / "state.db"
    db = SessionDB(db_path=db_path)
    db.create_session(session_id="rpc-list-session", source="desktop")
    wrote = threading.Event()
    released = threading.Event()
    frames: list[dict[str, Any]] = []

    class RecordingTransport:
        def write(self, frame):
            frames.append(frame)
            wrote.set()
            return True

        def close(self):
            return None

    monkeypatch.setattr(server, "_db", db)
    real_release = server._release_rpc_thread_read_connection

    def release_and_signal():
        try:
            real_release()
        finally:
            released.set()

    monkeypatch.setattr(
        server,
        "_release_rpc_thread_read_connection",
        release_and_signal,
    )

    try:
        response = server.dispatch(
            {
                "id": "rpc-list",
                "method": "session.list",
                "params": {"limit": 5},
            },
            RecordingTransport(),
        )
        assert response is None
        assert wrote.wait(timeout=5)
        assert released.wait(timeout=5)
        assert frames[0]["result"]["sessions"][0]["id"] == "rpc-list-session"
        with db._read_conns_lock:
            assert db._read_conns_closed is False
    finally:
        db.close()


def test_teardown_closes_owned_db_via_agent_close(tmp_path):
    """A transferred profile handle is closed by the owning agent's lifecycle."""
    db_path = tmp_path / "state.db"
    db = SessionDB(db_path=db_path)

    class SyntheticAgent:
        session_id = "synthetic-session"
        model = "synthetic"
        platform = "desktop"

        def __init__(self, session_db):
            # Model the real ownership transfer: the agent receives the exact handle opened by the
            # session, so the production identity guard remains strict.
            self._session_db = session_db

        def close(self):
            if self._owns_session_db:
                self._owns_session_db = False
                self._session_db.close()

    agent = SyntheticAgent(db)
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


def test_profile_session_teardown_shuts_down_context_engine_sqlite(tmp_path):
    """A session-owned context engine must release its SQLite resources."""
    state_path = tmp_path / "state.db"
    context_path = tmp_path / "lcm.db"
    db = SessionDB(db_path=state_path)
    agent = _bare_agent(db, "context-engine-session")
    db.create_session(session_id=agent.session_id, source="desktop")
    assert server._transfer_db_to_agent(agent, db) is True

    class SQLiteContextEngine:
        def __init__(self):
            self.connection = sqlite3.connect(context_path)
            self.shutdown_count = 0

        def shutdown(self):
            self.shutdown_count += 1
            self.connection.close()

    engine = SQLiteContextEngine()
    agent.context_compressor = engine
    assert _sqlite_fds(context_path) >= 1

    server._teardown_session(
        {
            "agent": agent,
            "history": [],
            "history_lock": threading.Lock(),
            "profile_home": str(tmp_path),
            "session_key": agent.session_id,
        }
    )
    agent.close()

    assert engine.shutdown_count == 1
    assert _sqlite_fds(context_path) == 0
    assert _tracked_connections(state_path) == 0


def test_session_close_waits_for_completed_turn_thread_before_context_shutdown(tmp_path):
    """Do not race context shutdown with post-message.complete turn unwind."""
    state_path = tmp_path / "state.db"
    context_path = tmp_path / "lcm.db"
    db = SessionDB(db_path=state_path)
    agent = _bare_agent(db, "settling-context-engine-session")
    db.create_session(session_id=agent.session_id, source="desktop")
    assert server._transfer_db_to_agent(agent, db) is True

    turn_started = threading.Event()
    turn_settled = threading.Event()

    def finish_turn():
        turn_started.set()
        time.sleep(0.2)
        turn_settled.set()

    run_thread = threading.Thread(target=finish_turn)
    run_thread.start()
    assert turn_started.wait(timeout=1)

    class BusySQLiteContextEngine:
        def __init__(self):
            self.connection = sqlite3.connect(context_path)
            self.shutdown_count = 0

        def shutdown(self):
            self.shutdown_count += 1
            if not turn_settled.is_set():
                raise RuntimeError("turn is still unwinding")
            self.connection.close()

    engine = BusySQLiteContextEngine()
    agent.context_compressor = engine
    session = {
        "agent": agent,
        "history": [],
        "history_lock": threading.Lock(),
        "profile_home": str(tmp_path),
        "session_key": agent.session_id,
        "_run_thread": run_thread,
        "_turn_terminal_state": "emitted",
    }

    try:
        server._teardown_popped_session(session)
        run_thread.join(timeout=1)
        assert not run_thread.is_alive()
        assert engine.shutdown_count == 1
        assert _sqlite_fds(context_path) == 0
    finally:
        run_thread.join(timeout=1)
        engine.connection.close()
        db.close()


def test_signal_shutdown_never_waits_past_finalization_grace(monkeypatch):
    """Signal shutdown must not join active, writing, or emitted turns."""

    class ActiveTurn:
        def __init__(self):
            self.join_calls = []

        def is_alive(self):
            return True

        def join(self, timeout=None):
            self.join_calls.append(timeout)

    torn_down = []
    monkeypatch.setattr(
        server,
        "_teardown_session",
        lambda session, *, end_reason="tui_close": torn_down.append(end_reason),
    )

    run_threads = []
    for terminal_state in ("active", "emitting", "emitted"):
        run_thread = ActiveTurn()
        run_threads.append(run_thread)
        assert server._teardown_popped_session(
            {
                "_run_thread": run_thread,
                "_turn_terminal_state": terminal_state,
            },
            end_reason="tui_shutdown",
        )
    assert [thread.join_calls for thread in run_threads] == [[], [], []]
    assert torn_down == ["tui_shutdown", "tui_shutdown", "tui_shutdown"]


def test_popped_session_blocks_queued_and_direct_followup_dispatch(monkeypatch):
    """A close ownership claim forbids successor turns from the old tail."""
    sid = "closing-followup-session"
    dispatched = []
    session = {
        "history_lock": threading.Lock(),
        "running": False,
        "queued_prompt": {"text": "next", "transport": None},
        "_queued_prompt_generation": 0,
    }
    monkeypatch.setattr(
        server,
        "_run_prompt_submit",
        lambda *args, **kwargs: dispatched.append((args, kwargs)),
    )

    with server._sessions_lock:
        server._sessions[sid] = session
    try:
        popped = server._pop_session_by_id(sid)
        assert popped is session
        assert session["_closing"] is True
        assert server._drain_queued_prompt("rid", sid, session) is False
        assert dispatched == []
    finally:
        with server._sessions_lock:
            server._sessions.pop(sid, None)


def test_run_prompt_submit_refuses_closing_session():
    """The dispatch boundary closes the check-then-start race."""
    session = {
        "history_lock": threading.Lock(),
        "running": True,
        "_closing": True,
    }

    dispatch_started = server._run_prompt_submit("rid", "sid", session, "next")

    assert dispatch_started is False
    assert session["running"] is False
    assert "_run_thread" not in session


def test_close_wins_race_before_turn_thread_publication(monkeypatch):
    """Turn startup revalidates close ownership under the registry lock."""
    sid = "close-before-thread-publication"
    started = []
    emitted = []
    session = {
        "agent": object(),
        "history_lock": threading.Lock(),
        "running": True,
        "attached_images": [],
    }

    class DeferredThread:
        def start(self):
            started.append(True)

    def claim_close_before_thread_is_published(*, target, daemon):
        assert target is not None
        assert daemon is True
        assert server._pop_session_by_id(sid) is session
        return DeferredThread()

    monkeypatch.setattr(server, "_emit", lambda *args, **kwargs: emitted.append(args))
    monkeypatch.setattr(server.threading, "Thread", claim_close_before_thread_is_published)
    with server._sessions_lock:
        server._sessions[sid] = session
    try:
        dispatch_started = server._run_prompt_submit("rid", sid, session, "next")
        assert dispatch_started is False
        assert started == []
        assert not any(event and event[0] == "message.start" for event in emitted)
        assert session["_closing"] is True
        assert session["running"] is False
        assert "_run_thread" not in session
    finally:
        with server._sessions_lock:
            server._sessions.pop(sid, None)
