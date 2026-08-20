import threading
from types import SimpleNamespace

import pytest

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
    monkeypatch.setattr(server, "record_turn_start", lambda *a, **k: marker_recorded)
    monkeypatch.setattr(server, "_emit", lambda *a, **k: None)
    monkeypatch.setattr(server, "_emit_terminal_turn_error", lambda *a, **k: None)

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
