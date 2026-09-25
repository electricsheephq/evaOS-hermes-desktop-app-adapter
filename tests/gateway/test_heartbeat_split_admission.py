"""Heartbeat admission must stay on the store-key lane used by its bookkeeping."""

import asyncio

import pytest

from gateway.config import GatewayConfig, Platform, PlatformConfig
from gateway.run import GatewayRunner
from gateway.session import SessionSource
from hermes_cli.heartbeat import HeartbeatState, save_heartbeat
from plugins.platforms.discord.adapter import DiscordAdapter


async def _drain(adapter):
    while adapter._background_tasks:
        await asyncio.gather(*list(adapter._background_tasks))


@pytest.mark.asyncio
@pytest.mark.parametrize(("split", "expected_fires"), [(True, 0), (False, 1)])
async def test_non_internal_heartbeat_does_not_cross_adapter_session_split(
    tmp_path, monkeypatch, split, expected_fires,
):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / ("split" if split else "shared")))
    runner = GatewayRunner(GatewayConfig(thread_sessions_per_user=False))
    adapter = DiscordAdapter(PlatformConfig(
        enabled=True,
        typing_indicator=False,
        extra={"thread_sessions_per_user": split},
    ))
    adapter.set_session_store(runner.session_store)
    runner.adapters = {Platform.DISCORD: adapter}
    source = SessionSource(
        platform=Platform.DISCORD,
        chat_type="thread",
        chat_id="heartbeat-thread",
        thread_id="heartbeat-thread",
        user_id="heartbeat-user",
    )
    entry = runner.session_store.get_or_create_session(source)
    key = entry.session_key
    fires = []

    async def handler(event):
        event._heartbeat_execution_started = True
        fires.append(event.text)

    adapter.set_message_handler(handler)
    save_heartbeat(entry.session_id, HeartbeatState(
        prompt="check status", interval_seconds=3600, created_at=1,
    ))
    watch = {key: (source, entry.session_id)}

    for _ in range(3):
        await runner._heartbeat_poll_once(watch)
        await _drain(adapter)

    assert len(fires) == expected_fires
