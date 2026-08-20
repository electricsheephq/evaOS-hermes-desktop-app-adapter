"""Bounded reader proof for historical SessionDB teardown fixes."""

import threading
from pathlib import Path

import pytest

from hermes_state import SessionDB, _READ_POOL_MAX
from run_agent import AIAgent
from tui_gateway import server


def _all_permits_available(db: SessionDB) -> None:
    while db._read_pool.qsize():
        db._close_read_conn(db._read_pool.get_nowait())
    held = [db._read_permits.acquire(blocking=False) for _ in range(_READ_POOL_MAX)]
    assert all(held), "the exercised path stranded a reader permit"
    assert not db._read_permits.acquire(blocking=False)
    for acquired in held:
        if acquired:
            db._read_permits.release()


def _bare_agent(db: SessionDB, session_id: str) -> AIAgent:
    agent = object.__new__(AIAgent)
    agent.session_id = session_id
    agent._session_db = db
    agent._owns_session_db = False
    return agent


@pytest.mark.requires_wal
def test_rpc_pool_session_list_returns_permits_after_many_requests(monkeypatch, tmp_path):
    """The historical RPC release site is covered by the bounded pool."""
    db = SessionDB(db_path=tmp_path / "state.db")
    db.create_session(session_id="rpc-permit", source="desktop")
    monkeypatch.setattr(server, "_db", db)

    try:
        for turn in range(25):
            wrote = threading.Event()
            frames = []

            class RecordingTransport:
                def write(self, frame):
                    frames.append(frame)
                    wrote.set()
                    return True

            response = server.dispatch(
                {
                    "id": f"rpc-{turn}",
                    "method": "session.list",
                    "params": {"limit": 5},
                },
                RecordingTransport(),
            )
            assert response is None
            assert wrote.wait(timeout=5), "RPC pool worker did not settle"
            assert frames[0]["result"]["sessions"][0]["id"] == "rpc-permit"

        assert db._read_permit_exhausted == 0
        _all_permits_available(db)
    finally:
        db.close()


@pytest.mark.requires_wal
def test_owned_session_teardown_closes_readers_for_25_cycles(tmp_path):
    """13038c72ad remains valid through the current owned-handle contract."""
    for cycle in range(25):
        db_path = Path(tmp_path) / f"owned-{cycle}" / "state.db"
        db = SessionDB(db_path=db_path)
        session_id = f"owned-{cycle}"
        db.create_session(session_id=session_id, source="desktop")
        assert db.get_session(session_id)["id"] == session_id
        agent = _bare_agent(db, session_id)
        assert server._transfer_db_to_agent(agent, db) is True

        server._teardown_session(
            {
                "agent": agent,
                "history": [],
                "history_lock": threading.Lock(),
                "profile_home": str(db_path.parent),
                "session_key": session_id,
            }
        )

        assert db._read_pool.qsize() == 0
        assert db._read_permit_exhausted == 0
        _all_permits_available(db)
