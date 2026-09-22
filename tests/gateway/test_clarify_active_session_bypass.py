"""Regression tests for clarify replies while a gateway session is busy."""

import asyncio
import concurrent.futures
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from gateway.config import GatewayConfig, Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    SendResult,
)
from gateway.platforms.event import MessageEvent, MessageType
from gateway.run_inbound import GatewayInboundMixin
from gateway.run_turn_runner import TurnRunner
from gateway.session import SessionSource, SessionStore, build_session_key
from gateway.turn_context import TurnContext


class _ClarifyBypassAdapter(BasePlatformAdapter):
    def __init__(self, platform=Platform.TELEGRAM):
        super().__init__(PlatformConfig(enabled=True, token="test"), platform)

    async def connect(self):
        return True

    async def disconnect(self):
        pass

    async def send(self, chat_id, content, reply_to=None, metadata=None):
        return SendResult(success=True, message_id="text")

    async def get_chat_info(self, chat_id):
        return {"id": chat_id, "type": "private"}


class _ClarifyInbound(GatewayInboundMixin):
    @staticmethod
    def _pending_event_audio_paths(event):
        return []

    @staticmethod
    async def _prepare_clarify_reply_text(event):
        return event.text

    @staticmethod
    def _adapter_for_source(source):
        return None


def _event(text="custom answer", *, platform=Platform.TELEGRAM, chat_type="private"):
    return MessageEvent(
        text=text,
        message_type=MessageType.TEXT,
        source=SessionSource(
            platform=platform,
            chat_id="12345",
            chat_type=chat_type,
            user_id="user1",
        ),
        message_id="msg1",
    )


def _clear_clarify_state():
    from tools import clarify_gateway as cm

    with cm._lock:
        cm._entries.clear()
        cm._session_index.clear()
        cm._notify_cbs.clear()


@pytest.mark.asyncio
async def test_active_session_routes_typed_choice_clarify_reply_to_runner_not_busy_queue():
    """Typed text must resolve a pending choice clarify even while the agent is busy.

    Telegram button clarifies keep the adapter session active while the agent
    thread blocks on ``wait_for_response``.  If the adapter only bypasses for
    entries already marked ``awaiting_text``, typed replies to the visible
    multi-choice prompt are handled as busy follow-ups and the clarify wait is
    never resolved.
    """
    _clear_clarify_state()
    from tools import clarify_gateway as cm

    adapter = _ClarifyBypassAdapter()
    adapter._message_handler = AsyncMock(return_value="")
    adapter._busy_session_handler = AsyncMock(return_value=True)
    event = _event("None of those are valid options")
    session_key = build_session_key(
        event.source,
        group_sessions_per_user=adapter.config.extra.get("group_sessions_per_user", True),
        thread_sessions_per_user=adapter.config.extra.get("thread_sessions_per_user", False),
    )
    adapter._session_store = MagicMock()
    adapter._session_store._generate_session_key.return_value = session_key
    adapter._active_sessions[session_key] = asyncio.Event()
    cm.register("clarify-1", session_key, "Pick one", ["A", "B"])

    await adapter.handle_message(event)

    adapter._message_handler.assert_awaited_once_with(event)
    adapter._busy_session_handler.assert_not_awaited()
    assert adapter._pending_messages == {}


@pytest.mark.asyncio
async def test_active_session_bypass_uses_profile_namespaced_key_under_multiplex():
    """Regression for issue #82975: under a named-profile multiplex, the
    adapter's clarify bypass lookup must use the SAME profile-namespaced
    session key that the runner registers pending clarifies under
    (SessionStore._generate_session_key() includes
    profile=self._resolve_profile_for_key(source)), not the legacy
    unnamespaced key. Otherwise the lookup misses, and a user's answer to
    a pending clarify is routed to the busy-session queue instead of
    resolving it -- the turn then hangs until the clarify's 3600s timeout."""
    _clear_clarify_state()
    from tools import clarify_gateway as cm

    adapter = _ClarifyBypassAdapter()
    adapter._message_handler = AsyncMock(return_value="")
    adapter._busy_session_handler = AsyncMock(return_value=True)
    event = _event("None of those are valid options")

    # A session_store configured for profile multiplexing, matching what
    # the runner's SessionStore._generate_session_key() actually produces.
    session_store = MagicMock()
    session_store._resolve_profile_for_key.return_value = "ops"
    adapter._session_store = session_store

    profile_namespaced_key = build_session_key(
        event.source,
        group_sessions_per_user=adapter.config.extra.get("group_sessions_per_user", True),
        thread_sessions_per_user=adapter.config.extra.get("thread_sessions_per_user", False),
        profile="ops",
    )
    # Sanity: the profile-namespaced key really is different from the
    # legacy unnamespaced one -- otherwise this test wouldn't distinguish
    # the fixed behavior from the bug.
    legacy_key = build_session_key(
        event.source,
        group_sessions_per_user=adapter.config.extra.get("group_sessions_per_user", True),
        thread_sessions_per_user=adapter.config.extra.get("thread_sessions_per_user", False),
    )
    assert profile_namespaced_key != legacy_key
    session_store._generate_session_key.return_value = profile_namespaced_key

    adapter._active_sessions[profile_namespaced_key] = asyncio.Event()
    # The runner registers the pending clarify under its own
    # profile-namespaced key, exactly as it would in a real multiplexed
    # deployment.
    cm.register("clarify-1", profile_namespaced_key, "Pick one", ["A", "B"])

    await adapter.handle_message(event)

    adapter._message_handler.assert_awaited_once_with(event)
    adapter._busy_session_handler.assert_not_awaited()
    assert adapter._pending_messages == {}


@pytest.mark.asyncio
async def test_discord_reply_resolves_waiter_registered_under_store_session_key(
    tmp_path, monkeypatch,
):
    """An active Discord reply uses the same key as the run-turn waiter."""
    _clear_clarify_state()
    from tools import clarify_gateway as cm

    event = _event("the requested detail", platform=Platform.DISCORD, chat_type="group")
    store = SessionStore(
        sessions_dir=tmp_path / "sessions",
        config=GatewayConfig(group_sessions_per_user=False),
    )
    adapter = _ClarifyBypassAdapter(Platform.DISCORD)
    adapter.set_session_store(store)
    adapter_key = adapter._event_session_key(event)
    store_key = store._generate_session_key(event.source)
    assert adapter_key != store_key

    inbound = _ClarifyInbound()

    async def _handle_inbound(delivered_event):
        return await inbound._hm_clarify_reply(
            delivered_event, delivered_event.source, store_key,
        )

    adapter._message_handler = _handle_inbound
    adapter._busy_session_handler = AsyncMock(return_value=False)
    adapter._active_sessions[adapter_key] = asyncio.Event()

    ctx = TurnContext(
        session_key=store_key,
        _status_adapter=adapter,
        _status_chat_id=event.source.chat_id,
    )
    runner = TurnRunner(MagicMock(), ctx)
    monkeypatch.setattr(runner, "_close_native_stream_boundary", lambda *args, **kwargs: True)
    monkeypatch.setattr(runner, "_stream_consumer", lambda: None)
    monkeypatch.setattr(cm, "get_clarify_timeout", lambda: 0.25)

    def _schedule(coro, _failure_message):
        coro.close()
        future = concurrent.futures.Future()
        future.set_result(SendResult(success=True, message_id="clarify"))
        return future

    monkeypatch.setattr(runner, "_schedule", _schedule)
    waiter = asyncio.create_task(asyncio.to_thread(runner._clarify_callback_sync, "What detail?", None))
    for _ in range(100):
        if cm.get_pending_for_session(store_key) is not None:
            break
        await asyncio.sleep(0.01)
    else:
        pytest.fail("run-turn path did not register the clarify waiter")

    await adapter.handle_message(event)

    assert await waiter == "the requested detail"
    assert adapter._pending_messages == {}
