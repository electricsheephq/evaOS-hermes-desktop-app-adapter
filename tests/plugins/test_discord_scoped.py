import json
from types import MappingProxyType

import pytest

from cron import jobs as cron_jobs
import cron.scheduler as scheduler
from cron.scheduler import SILENT_MARKER, _build_job_prompt, _invoke_cron_preflight, run_job
from plugins.discord_scoped import _commit, _preflight


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


def test_preflight_processes_oldest_humans_without_skipping_or_bot_wake(monkeypatch):
    calls = []

    def request(method, path, _token, params=None, body=None):
        calls.append((method, path, params, body))
        if path == "/channels/300":
            return {"id": "300", "guild_id": "100", "parent_id": "200", "type": 11}
        return [
            {"id": "403", "content": "new", "author": {"bot": False}},
            {"id": "402", "content": "delivery", "author": {"bot": True}},
            {"id": "401", "content": "old", "author": {"bot": False}},
        ]

    monkeypatch.setattr("plugins.discord_scoped._get_bot_token", lambda: "redacted")
    monkeypatch.setattr("plugins.discord_scoped._discord_request", request)
    job = _job(preflight={**_job()["preflight"], "limit": 1})
    _save(job)
    result = _preflight(provider="discord_scoped", job=job)
    assert result["action"] == "continue", result
    assert [row["id"] for row in json.loads(result["context"])["discord_messages"]] == ["401"]
    assert result["receipt"]["next"] == "401"
    assert cron_jobs.get_job("job-1")["preflight"]["checkpoint"] == "400"
    assert _commit(provider="discord_scoped", job=job, receipt=result["receipt"])["ok"]
    assert cron_jobs.get_job("job-1")["preflight"]["checkpoint"] == "401"

    bad = _job(preflight={**job["preflight"], "guild_id": "999"})
    assert _preflight(provider="discord_scoped", job=bad)["action"] == "error"
    assert cron_jobs.get_job("job-1")["preflight"]["checkpoint"] == "401"

    monkeypatch.setattr("plugins.discord_scoped._discord_request", lambda method, path, token, **kwargs: (
        {"id": "300", "guild_id": "100", "parent_id": "200", "type": 11}
        if path == "/channels/300" else [{"id": "404", "author": {"bot": True}}]
    ))
    assert _preflight(provider="discord_scoped", job=job)["action"] == "silent"


def test_prompt_injection_checkpoint_guards_and_script_rejection(monkeypatch):
    prompt = _build_job_prompt({"prompt": "summarize"}, preflight_context='{"id":"401"}')
    assert "Preflight Data" in prompt and '"id":"401"' in prompt

    job = _job(script="fixture.py")
    monkeypatch.setattr("cron.scheduler._invoke_cron_preflight", lambda _job: pytest.fail("REST preflight ran"))
    monkeypatch.setattr("cron.scheduler._run_job_script_with_claim_heartbeat", lambda *_a, **_k: pytest.fail("script ran"))
    assert run_job(job)[3] == "Cron preflight and script cannot be combined"
    assert run_job({**job, "no_agent": True})[3] == "Cron preflight and script cannot be combined"

    _save(_job())
    receipt = {"job_id": "job-1", "prior": "400", "next": "399",
               "policy_hash": _preflight_hash(_job())}
    assert not _commit(provider="discord_scoped", job=_job(), receipt=receipt)["ok"]
    assert cron_jobs.get_job("job-1")["preflight"]["checkpoint"] == "400"


def _preflight_hash(job):
    from plugins.discord_scoped import _policy, _policy_hash
    return _policy_hash(_policy(job))


def test_checkpoint_commits_only_after_nonempty_successful_delivery(monkeypatch):
    receipt = {"provider": "discord_scoped", "action": "continue", "receipt": {"next": "401"}}
    commits = []
    monkeypatch.setattr(scheduler, "claim_dispatch", lambda _id: True)
    monkeypatch.setattr(scheduler, "create_execution", lambda *_a, **_k: {"id": "exec"})
    monkeypatch.setattr(scheduler, "mark_execution_running", lambda *_a: None)
    monkeypatch.setattr(scheduler, "finish_execution", lambda *_a, **_k: None)
    monkeypatch.setattr(scheduler, "save_job_output", lambda *_a: "fixture")
    monkeypatch.setattr(scheduler, "mark_job_run", lambda *_a, **_k: None)
    monkeypatch.setattr(scheduler, "_consume_interrupted_flag", lambda *_a: False)
    monkeypatch.setattr(scheduler, "_is_interrupted", lambda *_a: False)
    monkeypatch.setattr(scheduler, "_teardown_cron_agent", lambda *_a: None)
    monkeypatch.setattr(scheduler, "_commit_cron_preflight", lambda *_a: commits.append(True))
    monkeypatch.setattr("agent.secret_scope.build_profile_secret_scope", lambda *_a: None)
    monkeypatch.setattr("agent.secret_scope.set_secret_scope", lambda *_a: None)
    monkeypatch.setattr("agent.secret_scope.reset_secret_scope", lambda *_a: None)

    outcomes = iter([(True, "answer", None), (True, "", None), (True, "answer", "failed"), (False, "answer", None)])
    def fake_run(job, **_kwargs):
        ok, final, _delivery = next(outcomes)
        job["_cron_preflight_result"] = receipt
        job["_test_delivery"] = _delivery
        return ok, "doc", final, None if ok else "agent failed"
    monkeypatch.setattr(scheduler, "run_job", fake_run)
    monkeypatch.setattr(scheduler, "_deliver_result", lambda job, *_a, **_k: job.pop("_test_delivery"))
    for _ in range(4):
        scheduler.run_one_job({"id": "job-1", "name": "fixture"})
    assert commits == [True]
