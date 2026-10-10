"""Shutdown flush files carry the session store's key, not the adapter's own key.

An adapter derives its slot key from its platform ``config.extra`` isolation flags while the
session store (and so ``resolve_session_id_for_key`` at restart recovery) uses the gateway-wide
flags. When the two differ (e.g. ``platforms.discord.extra.thread_sessions_per_user: true`` with
the top-level default ``false``) a flushed thread message was written under the per-user-suffixed
adapter key, which the resolver can never map: the file was retried and kept on every restart
and the message never reached the transcript (seen on one fleet profile, r34.9).
"""

import json
from unittest.mock import patch

import pytest

from gateway.platforms.event import MessageEvent
from gateway.session import SessionStore
from gateway.shutdown_flush import recover_pending_to_db
from tests.gateway.restart_test_helpers import make_restart_runner, make_restart_source


def _split_policy_runner(monkeypatch, tmp_path):
    flush_dir = tmp_path / "pending_messages"
    flush_dir.mkdir()
    monkeypatch.setattr("gateway.shutdown_flush._get_flush_dir", lambda: flush_dir)
    runner, adapter = make_restart_runner()
    # Real store-key derivation from the gateway-wide flags (thread_sessions_per_user=False).
    store = object.__new__(SessionStore)
    store.config = runner.config
    runner.session_store = store
    adapter.set_session_store(store)
    # The adapter's own platform policy isolates threads per user.
    adapter.config.extra["thread_sessions_per_user"] = True
    source = make_restart_source(chat_id="900", chat_type="thread", thread_id="900")
    event = MessageEvent(text="queued while restarting", source=source, message_id="7")
    adapter_key = adapter._event_session_key(event)
    store_key = store._generate_session_key(source)
    assert adapter_key == f"{store_key}:u1"  # precondition: the two policies really diverge
    return runner, adapter, event, adapter_key, store_key, flush_dir


def _flushed_keys(flush_dir):
    return [json.loads(p.read_text(encoding="utf-8"))["session_key"]
            for p in sorted(flush_dir.glob("*.json"))]


def _recover(flush_dir, store_key):
    rows = []

    class DB:
        def append_message(self, **kwargs):
            rows.append(kwargs)

    def resolver(session_key, not_after=None):
        return ("sess-1", DB()) if session_key == store_key else None

    recovered = recover_pending_to_db(DB(), session_resolver=resolver)
    return recovered, rows


@pytest.mark.asyncio
async def test_adapter_slot_flush_uses_store_key_and_recovers(monkeypatch, tmp_path):
    _runner, adapter, event, adapter_key, store_key, flush_dir = _split_policy_runner(
        monkeypatch, tmp_path)
    adapter._pending_messages[adapter_key] = event

    await adapter.cancel_background_tasks()

    assert _flushed_keys(flush_dir) == [store_key]
    recovered, rows = _recover(flush_dir, store_key)
    assert recovered == 1
    assert [r["content"] for r in rows] == ["queued while restarting"]
    assert list(flush_dir.glob("*.json")) == []


@pytest.mark.asyncio
async def test_runner_overflow_flush_uses_store_key_and_recovers(monkeypatch, tmp_path):
    runner, _adapter, event, adapter_key, store_key, flush_dir = _split_policy_runner(
        monkeypatch, tmp_path)
    # The busy handler queues under the adapter's key (it receives the adapter's session_key).
    runner._queued_events = {adapter_key: [event]}
    runner._restart_drain_timeout = 0.0

    with (
        patch("gateway.status.remove_pid_file"),
        patch("gateway.status.publish_runtime_status"),
        patch("agent.auxiliary_client.shutdown_cached_clients"),
    ):
        await runner.stop()

    assert _flushed_keys(flush_dir) == [store_key]
    recovered, rows = _recover(flush_dir, store_key)
    assert recovered == 1
    assert [r["content"] for r in rows] == ["queued while restarting"]


def test_flush_without_source_keeps_slot_key(monkeypatch, tmp_path):
    """Runner-level string slots carry no source: their key is written unchanged."""
    from gateway.shutdown_flush import flush_pending_to_file
    flush_dir = tmp_path / "pending_messages"
    flush_dir.mkdir()
    monkeypatch.setattr("gateway.shutdown_flush._get_flush_dir", lambda: flush_dir)
    flush_pending_to_file({"agent:main:telegram:dm:1": "text"},
                          session_key_for=lambda source: "other")
    assert _flushed_keys(flush_dir) == ["agent:main:telegram:dm:1"]
