"""Real adapter admission is the completion acknowledgement boundary."""
import asyncio
import logging
import queue
import time

import pytest

from gateway.config import GatewayConfig, Platform, PlatformConfig
from gateway.platforms.event import MessageEvent
from gateway.run import GatewayRunner, _AGENT_PENDING_SENTINEL
from gateway.session import SessionSource, build_session_key
from hermes_state import SessionDB
from plugins.platforms.discord.adapter import DiscordAdapter
from tools import async_delegation as delegation


def pending(key, name):
    evt = {"type": "async_delegation", "session_key": key, "delegation_id": name,
           "summary": name, "status": "completed", "dispatched_at": time.time()}
    delegation._persist_dispatch(evt)
    delegation._persist_completion(evt, {"status": "completed", "summary": name})
    return evt


async def drain(adapter):
    while adapter._background_tasks:
        await asyncio.gather(*list(adapter._background_tasks))


class RunningAgentStub:
    _supports_active_turn_redirect = False
    _active_children = ()

    def __init__(self):
        self.interrupt_calls = []
        self.redirect_calls = []
        self.steer_calls = []

    def interrupt(self, text):
        self.interrupt_calls.append(text)

    def redirect(self, text):
        self.redirect_calls.append(text)
        return True

    def steer(self, text):
        self.steer_calls.append(text)
        return True


@pytest.mark.asyncio
async def test_completion_ack_requires_admission_and_replay_never_repeats(tmp_path):
    runner = GatewayRunner(GatewayConfig())
    adapter = DiscordAdapter(PlatformConfig(enabled=True, typing_indicator=False))
    runner.adapters = {Platform.DISCORD: adapter}
    source = SessionSource(platform=Platform.DISCORD, chat_type="dm", chat_id="42", user_id="42")
    key = build_session_key(source)
    events = [pending(key, f"admission-{i}") for i in range(2)]
    received = []
    release, started = asyncio.Event(), asyncio.Event()

    async def handler(event):
        received.append(event.text)
        started.set()
        await release.wait()
        if key not in adapter._pending_messages:
            queued = runner._promote_queued_event(key, adapter, None)
            if queued is not None:
                adapter._pending_messages[key] = queued

    try:
        # Missing handler must not acknowledge either durable sibling.
        for _ in range(10):
            assert await runner._deliver_async_delegation_group(events) is False
        for event in events:
            row = delegation.get_durable_delegation(event["delegation_id"])
            assert (row["delivery_state"], row["delivery_attempts"]) == ("pending", 0)
        assert not runner._completion_deliveries_delivered
        adapter.set_message_handler(handler)
        await adapter.handle_message(MessageEvent(text="human-active", source=source))
        await asyncio.wait_for(started.wait(), 2)
        await adapter.handle_message(MessageEvent(text="human-pending", source=source))
        adapter.set_busy_session_handler(runner._handle_active_session_busy_message)
        runner._BUSY_QUEUE_MAX_PENDING = 1
        for _ in range(10):
            assert await runner._deliver_async_delegation_group(events) is False
        assert adapter._pending_messages[key].text == "human-pending"
        assert not runner._completion_deliveries_delivered
        for event in events:
            row = delegation.get_durable_delegation(event["delegation_id"])
            assert (row["delivery_state"], row["delivery_attempts"]) == ("pending", 0)
        # A permanent adapter-key mismatch on the non-durable path drops instead of requeueing.
        adapter.set_session_store(runner.session_store)
        wrong = dict(events[0], session_key="agent:main:discord:dm:other",
                     platform="discord", chat_type="dm", chat_id="42")
        assert await runner._inject_watch_notification("wrong-route", wrong) is None
        runner._BUSY_QUEUE_MAX_PENDING = 4
        assert await runner._deliver_async_delegation_group(events) is True
        assert await runner._deliver_async_delegation_group(events) is None
        release.set()
        await drain(adapter)
        assert received[:2] == ["human-active", "human-pending"]
        assert len(received) == 3 and all(event["summary"] in received[-1] for event in events)
        for event in events:
            assert delegation.get_durable_delegation(event["delegation_id"])["delivery_state"] == "delivered"
        idle = pending(key, "idle-admitted")
        assert await runner._deliver_async_delegation_group([idle]) is True
        await drain(adapter)
        assert len(received) == 4 and "idle-admitted" in received[-1]
    finally:
        release.set()
        await drain(adapter)
        await runner._cancel_process_completion_batch_tasks()


@pytest.mark.asyncio
async def test_permanent_watch_route_mismatch_is_dropped_from_drain(caplog):
    runner = GatewayRunner(GatewayConfig())
    adapter = DiscordAdapter(PlatformConfig(enabled=True, typing_indicator=False))
    adapter.set_session_store(runner.session_store)
    received = []

    async def handler(event):
        received.append(event)

    adapter.set_message_handler(handler)
    runner.adapters = {Platform.DISCORD: adapter}
    completion_queue = queue.Queue()
    completion_queue.put({
        "type": "watch_match", "session_id": "watch-route-mismatch",
        "session_key": "agent:main:discord:dm:other", "platform": "discord",
        "chat_type": "dm", "chat_id": "42", "pattern": "READY",
        "command": "build", "output": "READY\n",
    })
    caplog.set_level(logging.WARNING)

    await runner._drain_watch_notifications(completion_queue)

    assert completion_queue.empty()
    assert received == []
    assert sum("Dropping internally routed event" in r.message for r in caplog.records) == 1


@pytest.mark.asyncio
async def test_unavailable_raw_route_is_quiet_without_hiding_invalid_routes(tmp_path, caplog):
    runner = GatewayRunner(GatewayConfig())
    runner.adapters = {}
    evt = pending("opaque-client-session", "raw-admission")
    caplog.set_level(logging.WARNING, logger="gateway.run")
    for _ in range(3):
        assert await runner._deliver_async_delegation_group([evt]) is False
    assert not caplog.records
    row = delegation.get_durable_delegation(evt["delegation_id"])
    assert (row["delivery_state"], row["delivery_attempts"]) == ("pending", 0)
    assert await runner._inject_watch_notification("watch", {"type": "watch_match", "session_key": "agent:broken"}) is None
    assert any("unresolvable" in record.message for record in caplog.records)
    # API recovery writes only the delivery row, never starts a model turn.
    from gateway.platforms.api_server import APIServerAdapter
    api = APIServerAdapter(PlatformConfig())
    db = SessionDB(tmp_path / "api.db")
    db.create_session(evt["session_key"], "api_server")
    api._ensure_session_db = lambda: db
    runner.adapters = {Platform.API_SERVER: api}
    try:
        caplog.clear()
        assert await runner._deliver_async_delegation_group([evt]) is True
        assert await runner._deliver_async_delegation_group([evt]) is None
        rows = db.get_messages(evt["session_key"])
        assert len(rows) == 1 and rows[0]["display_kind"] == "async_delegation_complete"
        assert not api._background_tasks and not caplog.records
    finally:
        db.close()


@pytest.mark.asyncio
async def test_completion_accepts_session_store_key_when_adapter_thread_policy_differs(caplog):
    runner = GatewayRunner(GatewayConfig(thread_sessions_per_user=False))
    adapter = DiscordAdapter(PlatformConfig(
        enabled=True,
        typing_indicator=False,
        extra={"thread_sessions_per_user": True},
    ))
    adapter.set_session_store(runner.session_store)
    runner.adapters = {Platform.DISCORD: adapter}
    source = SessionSource(
        platform=Platform.DISCORD,
        chat_type="thread",
        chat_id="thread-348",
        thread_id="thread-348",
        user_id="user-348",
    )
    key = runner.session_store._generate_session_key(source)
    assert not key.endswith(f":{source.user_id}")
    evt = pending(key, "store-key-admitted")
    evt["user_id"] = source.user_id
    runner._enrich_async_delegation_routing(evt)
    received = []

    async def handler(event):
        assert runner._session_key_for_source(event.source) == key
        received.append(event.text)

    adapter.set_message_handler(handler)
    caplog.set_level(logging.WARNING)
    try:
        outcomes = [await runner._deliver_async_delegation_group([evt]) for _ in range(20)]
        row = delegation.get_durable_delegation(evt["delegation_id"])
        route_drops = [
            record for record in caplog.records
            if "Dropping internally routed event" in record.message
        ]
        assert outcomes[0] is True, (
            f"outcomes={outcomes}, state={row['delivery_state']}, "
            f"attempts={row['delivery_attempts']}, route_drops={len(route_drops)}"
        )
        await drain(adapter)
        assert row["delivery_state"] == "delivered"
        assert len(received) == 1 and evt["summary"] in received[0]
    finally:
        await drain(adapter)
        await runner._cancel_process_completion_batch_tasks()


@pytest.mark.asyncio
async def test_shared_thread_completion_queues_while_store_session_is_busy():
    runner = GatewayRunner(GatewayConfig(thread_sessions_per_user=False))
    adapter = DiscordAdapter(PlatformConfig(
        enabled=True,
        typing_indicator=False,
        extra={"thread_sessions_per_user": True},
    ))
    adapter.set_session_store(runner.session_store)
    runner.adapters = {Platform.DISCORD: adapter}
    created_by_a = SessionSource(
        platform=Platform.DISCORD,
        chat_type="thread",
        chat_id="shared-thread",
        thread_id="shared-thread",
        user_id="user-a",
    )
    entry = runner.session_store.get_or_create_session(created_by_a)
    key = entry.session_key
    evt = pending(key, "shared-thread-busy")
    evt.update(user_id="user-b")

    async def handler(event):
        assert event.source.user_id == "user-a"
        return await runner._handle_message(event)

    adapter.set_message_handler(handler)
    runner._session_state(key).turn.agent = _AGENT_PENDING_SENTINEL
    try:
        assert await runner._deliver_async_delegation_group([evt]) is True
        await drain(adapter)
        assert adapter._pending_messages[key].internal is True
        assert "shared-thread-busy" in adapter._pending_messages[key].text
        assert runner._session_state(key).turn.agent is _AGENT_PENDING_SENTINEL
    finally:
        runner._session_state(key).turn.agent = None
        adapter._pending_messages.clear()
        await drain(adapter)
        await runner._cancel_process_completion_batch_tasks()


@pytest.mark.asyncio
async def test_shared_thread_completion_queues_without_interrupting_running_agent():
    runner = GatewayRunner(GatewayConfig(thread_sessions_per_user=False))
    adapter = DiscordAdapter(PlatformConfig(
        enabled=True,
        typing_indicator=False,
        extra={"thread_sessions_per_user": True},
    ))
    adapter.set_session_store(runner.session_store)
    runner.adapters = {Platform.DISCORD: adapter}
    created_by_a = SessionSource(
        platform=Platform.DISCORD,
        chat_type="thread",
        chat_id="shared-running-thread",
        thread_id="shared-running-thread",
        user_id="user-a",
    )
    entry = runner.session_store.get_or_create_session(created_by_a)
    key = entry.session_key
    evt = pending(key, "shared-thread-running")
    evt.update(user_id="user-b")

    async def handler(event):
        assert event.source.user_id == "user-a"
        return await runner._handle_message(event)

    adapter.set_message_handler(handler)
    running_agent = RunningAgentStub()
    runner._session_state(key).turn.agent = running_agent
    try:
        assert await runner._deliver_async_delegation_group([evt]) is True
        await drain(adapter)
        assert running_agent.interrupt_calls == []
        assert running_agent.redirect_calls == []
        assert running_agent.steer_calls == []
        assert adapter._pending_messages[key].internal is True
        assert "shared-thread-running" in adapter._pending_messages[key].text
    finally:
        runner._session_state(key).turn.agent = None
        adapter._pending_messages.clear()
        await drain(adapter)
        await runner._cancel_process_completion_batch_tasks()


@pytest.mark.asyncio
async def test_mismatched_non_durable_notice_is_not_requeued_with_dropped_final(
    monkeypatch, caplog,
):
    from tools import process_registry as process_registry_module

    runner = GatewayRunner(GatewayConfig())
    adapter = DiscordAdapter(PlatformConfig(enabled=True, typing_indicator=False))
    adapter.set_session_store(runner.session_store)
    adapter.set_message_handler(lambda _event: None)
    runner.adapters = {Platform.DISCORD: adapter}
    runner._running = True

    final = pending("agent:main:discord:dm:other", "notice-route-mismatch")
    final.update(platform="discord", chat_type="dm", chat_id="42")
    notice = dict(
        final,
        task_failure_notice=True,
        is_batch=True,
        n_tasks=1,
        results=[{"task_index": 0, "status": "failed", "goal": "probe", "error": "boom"}],
    )
    claim_id = "test-terminal-final"
    assert delegation.claim_completion_delivery(final["delegation_id"], claim_id)
    assert delegation.drop_completion_delivery(final["delegation_id"], claim_id)

    isolated = queue.Queue()
    isolated.put(notice)
    isolated.put(final)
    monkeypatch.setattr(process_registry_module.process_registry, "completion_queue", isolated)
    sleep_calls = 0

    async def stop_after_one_pass(_delay):
        nonlocal sleep_calls
        sleep_calls += 1
        if sleep_calls >= 2:
            runner._running = False

    monkeypatch.setattr(asyncio, "sleep", stop_after_one_pass)
    caplog.set_level(logging.WARNING)
    await runner._async_delegation_watcher(interval=0)

    assert isolated.empty()
    assert delegation.get_durable_delegation(final["delegation_id"])["delivery_state"] == "dropped"
    assert sum("Dropping internally routed event" in record.message for record in caplog.records) == 1


@pytest.mark.asyncio
async def test_permanent_route_mismatch_exhausts_delivery_attempts(caplog):
    runner = GatewayRunner(GatewayConfig())
    adapter = DiscordAdapter(PlatformConfig(enabled=True, typing_indicator=False))
    adapter.set_session_store(runner.session_store)
    received = []

    async def handler(event):
        received.append(event.text)

    adapter.set_message_handler(handler)
    runner.adapters = {Platform.DISCORD: adapter}
    wrong = pending("agent:main:discord:dm:other", "wrong-route-exhausted")
    wrong.update(platform="discord", chat_type="dm", chat_id="42")
    caplog.set_level(logging.WARNING)
    try:
        outcomes = [await runner._deliver_async_delegation_group([wrong]) for _ in range(8)]
        row = delegation.get_durable_delegation(wrong["delegation_id"])
        exhausted = [
            record for record in caplog.records
            if "exhausted its 8 delivery attempts" in record.message
        ]
        assert (row["delivery_state"], row["delivery_attempts"]) == ("dropped", 8), (
            f"outcomes={outcomes}, state={row['delivery_state']}, attempts={row['delivery_attempts']}"
        )
        assert outcomes == [False] * 8
        assert await runner._deliver_async_delegation_group([wrong]) is None
        assert len(exhausted) == 1
        assert received == []
    finally:
        await drain(adapter)
        await runner._cancel_process_completion_batch_tasks()
