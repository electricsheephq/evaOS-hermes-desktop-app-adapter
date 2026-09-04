import hashlib
import json
import time
from types import MappingProxyType

import pytest

from cron import jobs as cron_jobs
from cron.scheduler import SILENT_MARKER, _invoke_cron_preflight, run_job
from plugins.discord_scoped import _commit, _list_threads, _preflight, _send_approved


@pytest.fixture(autouse=True)
def _active_profile(monkeypatch):
    monkeypatch.setattr("plugins.discord_scoped.get_active_profile_name", lambda: "custom")


def _job(**extra):
    base = {
        "id": "job-1",
        "preflight": {
            "provider": "discord_scoped",
            "profile": "custom",
            "guild_id": "100",
            "parent_channel_id": "200",
            "thread_id": "300",
            "checkpoint": "400",
            "limit": 10,
        },
    }
    base.update(extra)
    return base


def _save(job):
    cron_jobs.save_jobs([job])


def test_scheduler_preflight_is_immutable_and_silent_skips_agent(monkeypatch):
    seen = {}

    def invoke(_name, **kwargs):
        seen["job"] = kwargs["job"]
        return [{"provider": "test", "action": "silent"}]

    monkeypatch.setattr("hermes_cli.plugins.discover_plugins", lambda: None)
    monkeypatch.setattr("hermes_cli.lifecycle.invoke_hook", invoke)
    result = _invoke_cron_preflight({"id": "x", "preflight": {"provider": "test"}})
    assert result["action"] == "silent"
    assert isinstance(seen["job"], MappingProxyType)
    assert isinstance(seen["job"]["preflight"], MappingProxyType)

    monkeypatch.setattr("cron.scheduler._invoke_cron_preflight", lambda _job: result)
    assert run_job({"id": "x", "preflight": {"provider": "test"}}) == (
        True, "", SILENT_MARKER, None
    )


def test_preflight_fails_closed_and_commits_checkpoint_only_on_success(monkeypatch):
    calls = []

    def request(method, path, _token, params=None, body=None):
        calls.append((method, path, params, body))
        if path == "/channels/300":
            return {"id": "300", "guild_id": "100", "parent_id": "200", "type": 11}
        return [{"id": "402", "content": "new"}, {"id": "401", "content": "older"}]

    monkeypatch.setattr("plugins.discord_scoped._get_bot_token", lambda: "redacted")
    monkeypatch.setattr("plugins.discord_scoped._discord_request", request)
    job = _job()
    _save(job)
    result = _preflight(provider="discord_scoped", job=job)
    assert result["action"] == "continue", result
    assert cron_jobs.get_job("job-1")["preflight"]["checkpoint"] == "400"
    assert _commit(provider="discord_scoped", job=job, receipt=result["receipt"])["ok"]
    assert cron_jobs.get_job("job-1")["preflight"]["checkpoint"] == "402"

    bad = _job(preflight={**job["preflight"], "guild_id": "999"})
    assert _preflight(provider="discord_scoped", job=bad)["action"] == "error"
    assert cron_jobs.get_job("job-1")["preflight"]["checkpoint"] == "402"


def test_thread_listing_is_bounded_metadata_only(monkeypatch):
    _save(_job())
    paths = []

    def request(_method, path, _token, params=None, body=None):
        paths.append(path)
        thread = {
            "id": "300", "name": "fixture", "guild_id": "100",
            "parent_id": "200", "type": 11,
            "thread_metadata": {"archived": "archived" in path, "locked": False,
                                "archive_timestamp": "2026-01-01T00:00:00Z"},
            "messages": [{"content": "must-not-leak"}],
        }
        if path.endswith("/active"):
            return {"threads": [thread]}
        return {"threads": [thread], "has_more": False}

    monkeypatch.setattr("plugins.discord_scoped._get_bot_token", lambda: "redacted")
    monkeypatch.setattr("plugins.discord_scoped._discord_request", request)
    payload = json.loads(_list_threads({"job_id": "job-1", "limit": 5, "max_pages": 1}))
    assert payload.get("count") == 1, payload
    assert set(payload["threads"][0]) == {
        "id", "name", "guild_id", "parent_id", "type", "state",
        "archived", "locked", "archive_timestamp",
    }
    assert len(paths) == 3
    assert "must-not-leak" not in json.dumps(payload)


def test_approved_send_is_exact_one_shot_and_rejects_before_transport(monkeypatch):
    message = "approved fixture"
    approval = {
        "id": "approval-1", "profile": "custom", "destination_id": "300",
        "message_sha256": hashlib.sha256(message.encode()).hexdigest(),
        "nonce": "nonce-1", "expires_at": time.time() + 60,
    }
    _save(_job(discord_approvals=[approval]))
    calls = []

    def request(method, path, _token, params=None, body=None):
        calls.append((method, path, body))
        if method == "GET":
            return {"id": "300", "guild_id": "100", "parent_id": "200", "type": 11,
                    "thread_metadata": {"archived": False, "locked": False}}
        return {"id": "sent"}

    monkeypatch.setattr("plugins.discord_scoped._get_bot_token", lambda: "redacted")
    monkeypatch.setattr("plugins.discord_scoped._discord_request", request)
    args = {"job_id": "job-1", "approval_id": "approval-1", "nonce": "nonce-1",
            "destination_id": "300", "message": message}

    assert "error" in json.loads(_send_approved({**args, "message": "changed"}))
    assert calls == []
    sent = json.loads(_send_approved(args))
    assert sent.get("success") is True, sent
    assert [call[0] for call in calls] == ["GET", "POST"]
    calls.clear()
    assert "error" in json.loads(_send_approved(args))
    assert calls == []

    expired = {**approval, "id": "expired", "nonce": "nonce-2",
               "used_at": None, "expires_at": time.time() - 1}
    _save(_job(discord_approvals=[expired]))
    assert "error" in json.loads(_send_approved({**args, "approval_id": "expired", "nonce": "nonce-2"}))
    assert calls == []
