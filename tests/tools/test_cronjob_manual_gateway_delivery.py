"""Manual delivery handoff and preserved direct/live lanes (adapter #404)."""

import asyncio
import json
import os
import sys
from concurrent.futures import Future
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from cron import delivery_queue, scheduler, scheduler_delivery, scheduler_preflight
from cron.executions import latest_execution
from cron.jobs import create_job, get_job
from gateway.config import Platform
from tools.cronjob_tools import _execute_job_now, _manual_run_completion


@pytest.fixture
def manual_delivery(monkeypatch):
    home = Path(os.environ["HERMES_HOME"])
    (home / "config.yaml").write_text(
        "platforms:\n  telegram:\n    enabled: true\n  discord:\n    enabled: true\n"
        "cron:\n  wrap_response: false\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(delivery_queue, "DELIVERY_DB", None)
    monkeypatch.setattr(delivery_queue, "DEFAULT_DELIVERY_WAIT_TIMEOUT_SECONDS", 0)
    monkeypatch.setitem(sys.modules, "gateway.run", None)
    monkeypatch.setattr(scheduler, "_launch_external_cron_worker", lambda job: False)

    def run(job, **kwargs):
        error = scheduler_preflight._preflight_check_delivery(job)
        return (False, "", "", error) if error else (True, "brief", "brief", None)

    monkeypatch.setattr(scheduler, "run_job", run)
    standalone = Mock(return_value=({"success": True}, None))
    monkeypatch.setattr(scheduler_delivery, "_standalone_send", standalone)
    sends = []

    async def live_send(self, target, text, metadata, transport=None):
        sends.append((target, text, transport))
        return {"success": True, "message_id": "synthetic-message"}

    def schedule(coro, loop):
        future = Future()
        future.set_result(asyncio.run(coro))
        return future

    monkeypatch.setattr("gateway.delivery.DeliveryRouter._deliver_to_platform", live_send)
    monkeypatch.setattr("agent.async_utils.safe_schedule_threadsafe", schedule)
    adapter = SimpleNamespace(supports_inchannel_continuable=False)
    runner = SimpleNamespace(
        adapters={Platform.TELEGRAM: adapter},
        _gateway_loop=SimpleNamespace(is_running=lambda: True),
    )

    def start(deliver="origin"):
        job = create_job(
            prompt="Produce a brief", schedule="every 1h", deliver=deliver,
            origin={"platform": "telegram", "chat_id": "123456789"},
        )
        result = _execute_job_now(job)
        stored = get_job(job["id"])
        execution = latest_execution(job["id"])
        return result, stored, execution

    return start, standalone, sends, runner


@pytest.mark.parametrize("lane", ["queued-origin", "queued-explicit", "direct", "live", "local", "write-failure"])
def test_manual_cron_delivery_routes_and_reports(lane, manual_delivery, monkeypatch):
    start, standalone, sends, runner = manual_delivery
    if lane == "direct":
        monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "123456:synthetic-test-credential")
    elif lane == "live":
        monkeypatch.setitem(sys.modules, "gateway.run", SimpleNamespace(_gateway_runner_ref=lambda: runner))
    elif lane == "write-failure":
        monkeypatch.setattr(delivery_queue, "enqueue", Mock(side_effect=OSError("handoff write failed")))
    deliver = "local" if lane == "local" else "telegram:123456789" if lane == "queued-explicit" else "origin"
    result, stored, execution = start(deliver)

    if lane.startswith("queued"):
        standalone.assert_not_called()
        assert sends == []
        assert result["success"] is True
        assert stored["last_status"] == "delivery_queued"
        assert execution["delivery_outcome"] == "queued"
        completion = _manual_run_completion(result, stored["id"], stored["name"], deliver, 0)
        assert "queued for the gateway" in completion["summary"]
        row = delivery_queue.get_status(execution["id"])
        assert row["status"] == "pending"
        assert row["content"] == "brief"
        assert json.loads(row["job_json"])["id"] == stored["id"]
    elif lane == "write-failure":
        standalone.assert_not_called()
        assert result["success"] is False
        assert stored["last_status"] == "delivery_failed"
        assert execution["delivery_outcome"] == "failed"
        assert "handoff write failed" in result["error"]
    else:
        assert result["success"] is True
        assert stored["last_status"] == "ok"
        assert not stored.get("last_delivery_queued")
        assert standalone.call_count == (1 if lane == "direct" else 0)
        assert len(sends) == (1 if lane == "live" else 0)


@pytest.mark.parametrize("mixed", [False, True])
def test_manual_cron_deferred_record_replays_once_through_live_adapter(manual_delivery, monkeypatch, mixed):
    start, standalone, sends, runner = manual_delivery
    if mixed:
        monkeypatch.setenv("DISCORD_BOT_TOKEN", "synthetic-test-credential")
    deliver = ["origin", "discord:987654321"] if mixed else "origin"
    result, stored, execution = start(deliver)
    assert result["success"] is True
    assert standalone.call_count == int(mixed)
    if mixed:
        assert standalone.call_args.args[0].platform == Platform.DISCORD
    row = delivery_queue.get_status(execution["id"])
    queued_targets = json.loads(row["job_json"])["_gateway_delivery_targets"]
    assert len(queued_targets) == 1
    assert queued_targets[0]["platform"] == "telegram"
    assert scheduler.drain_delivery_queue(runner.adapters, runner._gateway_loop) == 1
    assert scheduler.drain_delivery_queue(runner.adapters, runner._gateway_loop) == 0
    assert len(sends) == 1
    target, text, transport = sends[0]
    assert target.platform == Platform.TELEGRAM
    assert target.chat_id == "123456789"
    assert text == "brief"
    assert transport.adapter is runner.adapters[Platform.TELEGRAM]
    assert standalone.call_count == int(mixed)
    assert delivery_queue.get_status(execution["id"])["status"] == "delivered"
    assert not get_job(stored["id"]).get("last_delivery_queued")


@pytest.mark.parametrize("outcome", ["failed", "delivered", "deferred"])
def test_manual_cron_queue_terminal_outcome(outcome, manual_delivery, monkeypatch):
    start, standalone, sends, runner = manual_delivery
    original_enqueue = delivery_queue.enqueue
    timeout = Mock(wraps=delivery_queue._terminalize_wait_timeout)
    monkeypatch.setattr(delivery_queue, "_terminalize_wait_timeout", timeout)
    if outcome == "failed":
        async def reject(*args, **kwargs):
            return {"success": False, "error": "gateway rejected delivery"}

        monkeypatch.setattr("gateway.delivery.DeliveryRouter._deliver_to_platform", reject)
        standalone.return_value = (None, "gateway rejected delivery")

    def enqueue_then_drain(execution_id, job, content, *, for_failure=False):
        receipt = original_enqueue(execution_id, job, content, for_failure=for_failure)
        if outcome != "deferred":
            # Complete before the producer sees its original pending snapshot.
            assert scheduler.drain_delivery_queue(runner.adapters, runner._gateway_loop) == 1
        return receipt

    monkeypatch.setattr(delivery_queue, "enqueue", enqueue_then_drain)
    result, stored, execution = start()
    row = delivery_queue.get_status(execution["id"])
    assert row["status"] == ("pending" if outcome == "deferred" else outcome)
    if outcome == "failed":
        assert result["success"] is False
        assert "gateway rejected delivery" in result["error"]
        assert "gateway rejected delivery" in stored["last_delivery_error"]
        assert stored["last_status"] == "delivery_failed"
        assert execution["delivery_outcome"] == "failed"
        assert not stored.get("last_delivery_queued")
    elif outcome == "delivered":
        assert result["success"] is True
        assert stored["last_status"] == "ok"
        assert execution["delivery_outcome"] == "delivered"
        assert not stored.get("last_delivery_queued")
        assert len(sends) == 1
        standalone.assert_not_called()
    else:
        timeout.assert_called_once_with(execution["id"])
        assert result["success"] is True
        assert result["error"] is None
        assert stored["last_delivery_error"] is None
        assert stored["last_status"] == "delivery_queued"
        assert execution["delivery_outcome"] == "queued"
        assert stored["last_delivery_queued"]
        standalone.assert_not_called()
        assert sends == []
