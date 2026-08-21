import threading
from types import SimpleNamespace

import pytest

from hermes_cli import kanban_db as kb
import tui_gateway.server as server


@pytest.mark.parametrize("marker_recorded", [False, True])
def test_async_durable_precondition_failure_restores_batch(monkeypatch, marker_recorded):
    batch = {
        "batch_id": "durable-batch",
        "items": [{"text": "synthetic kanban completion"}],
        "attempts": 1,
    }
    session = {
        "agent": SimpleNamespace(session_id="agent", clear_interrupt=lambda: None),
        "history": [],
        "history_lock": threading.Lock(),
        "running": True,
        "session_key": "synthetic-session",
    }
    settlement_calls = []
    terminal_states = []
    monkeypatch.setattr(server, "record_turn_start", lambda *a, **k: marker_recorded)
    monkeypatch.setattr(server, "_retire_turn_marker", lambda *a, **k: None)
    monkeypatch.setattr(server, "_get_usage", lambda *a, **k: {})
    monkeypatch.setattr(server, "render_message", lambda *a, **k: "")

    def capture_emit(method, _sid, _payload=None):
        if method == "message.complete":
            terminal_states.append(
                (session["running"], session["inflight_turn"]["status"])
            )

    monkeypatch.setattr(server, "_emit", capture_emit)

    started = server._run_prompt_submit(
        "rid", "sid", session, "synthetic kanban completion",
        on_turn_recorded=lambda: settlement_calls.append(True) or False,
        on_turn_rejected=lambda: server._restore_async_kanban_batch(
            "sid", session, batch
        ),
    )
    assert started is True
    session["_run_thread"].join(timeout=5)

    assert session["_kanban_pending"] == [batch]
    assert session["running"] is False
    assert settlement_calls == ([True] if marker_recorded else [])
    assert terminal_states == [(True, "error")]

    with session["history_lock"]:
        server._start_inflight_turn(session, "later user prompt")
    assert session["inflight_turn"]["user"] == "later user prompt"
    assert session["inflight_turn"].get("status") != "error"


def test_visible_and_silent_kanban_claim_settles_every_event_id(tmp_path, monkeypatch):
    db_path = tmp_path / "kanban.db"
    hermes_home = tmp_path / ".hermes"
    hermes_home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes_home))
    monkeypatch.setenv("HERMES_KANBAN_DB", str(db_path))
    kb.init_db()

    conn = kb.connect()
    try:
        task_id = kb.create_task(conn, title="mixed delivery", assignee="worker")
        kb.add_notify_sub(
            conn, task_id=task_id, platform="tui", chat_id="session-1"
        )
        kb.complete_task(conn, task_id, summary="done")
        kb.archive_task(conn, task_id)
        expected_event_ids = [
            event.id
            for event in kb.list_events(conn, task_id)
            if event.kind in {"completed", "archived"}
        ]
    finally:
        conn.close()

    items = server._collect_kanban_notifications(
        {"session_key": "session-1"}, include_identity=True
    )

    assert len(items) == 1
    assert "done" in items[0]["text"]
    assert server._kanban_batch_event_ids(items) == expected_event_ids

    with kb.connect() as conn:
        sub = kb.list_notify_subs(conn, task_id)[0]
        assert kb._decode_pending_delivery(sub["pending_event_ids"])[0] == expected_event_ids
        assert kb.complete_notify_delivery(
            conn,
            task_id=task_id,
            platform="tui",
            chat_id="session-1",
            event_ids=server._kanban_batch_event_ids(items),
            delivery_owner=server._KANBAN_DELIVERY_OWNER,
        ) is True
        assert kb.list_notify_subs(conn, task_id) == []
