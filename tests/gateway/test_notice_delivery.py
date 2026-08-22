from unittest.mock import AsyncMock, MagicMock

import pytest

from gateway.config import GatewayConfig, Platform, PlatformConfig
from gateway.platforms.base import SendResult
from gateway.run import GatewayRunner
from gateway.session import SessionSource


def _make_source() -> SessionSource:
    return SessionSource(
        platform=Platform.SLACK,
        chat_id="C123",
        chat_type="channel",
        user_id="U123",
        thread_id="111.222",
    )


def _make_runner(extra=None):
    runner = object.__new__(GatewayRunner)
    runner.config = GatewayConfig(
        platforms={
            Platform.SLACK: PlatformConfig(enabled=True, token="***", extra=extra or {})
        }
    )
    adapter = MagicMock()
    adapter.send = AsyncMock(return_value=SendResult(success=True, message_id="public-1"))
    adapter.send_private_notice = AsyncMock(return_value=SendResult(success=True, message_id="private-1"))
    runner.adapters = {Platform.SLACK: adapter}
    return runner, adapter


@pytest.mark.asyncio
async def test_deliver_platform_notice_uses_private_delivery_when_configured():
    runner, adapter = _make_runner(extra={"notice_delivery": "private"})

    await runner._deliver_platform_notice(_make_source(), "hello")

    adapter.send_private_notice.assert_awaited_once_with(
        "C123",
        "U123",
        "hello",
        metadata={"thread_id": "111.222"},
    )
    adapter.send.assert_not_awaited()


@pytest.mark.asyncio
async def test_private_only_notice_never_falls_back_to_public_delivery():
    runner, adapter = _make_runner(extra={"notice_delivery": "public"})
    adapter.send_private_notice.return_value = SendResult(success=False, error="denied")

    await runner._deliver_platform_notice(
        _make_source(),
        "private capability",
        private_only=True,
    )

    adapter.send_private_notice.assert_awaited_once_with(
        "C123",
        "U123",
        "private capability",
        metadata={"thread_id": "111.222"},
    )
    adapter.send.assert_not_awaited()


@pytest.mark.asyncio
async def test_private_only_notice_without_user_is_dropped():
    runner, adapter = _make_runner(extra={"notice_delivery": "public"})
    source = _make_source()
    source.user_id = ""

    await runner._deliver_platform_notice(
        source,
        "private capability",
        private_only=True,
    )

    adapter.send_private_notice.assert_not_awaited()
    adapter.send.assert_not_awaited()
