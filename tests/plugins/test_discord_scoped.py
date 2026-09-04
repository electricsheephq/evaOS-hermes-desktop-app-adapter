import json
from types import MappingProxyType

import pytest

from cron import jobs as cron_jobs
import cron.scheduler as scheduler
from cron.scheduler import SILENT_MARKER, _build_job_prompt, _invoke_cron_preflight, run_job
from plugins.discord_scoped import _commit, _preflight
from plugins.discord_scoped import approved


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


def _bind_cron_job(job_id):
    from gateway.session_context import _CRON_JOB_ID, _CRON_SESSION

    return (
        _CRON_SESSION.set("1"),
        _CRON_JOB_ID.set(job_id),
    )


def _unbind_cron_job(tokens):
    from gateway.session_context import _CRON_JOB_ID, _CRON_SESSION

    _CRON_JOB_ID.reset(tokens[1])
    _CRON_SESSION.reset(tokens[0])


def test_approved_thread_listing_is_bounded_metadata_only(monkeypatch):
    calls = []

    def request(method, path, _token, params=None, body=None):
        calls.append((method, path, params, body))
        if path.endswith("/threads/active"):
            return {
                "threads": [
                    {
                        "id": "301",
                        "guild_id": "100",
                        "parent_id": "200",
                        "name": "active fixture",
                        "type": 11,
                        "content": "must never escape",
                        "thread_metadata": {"locked": False},
                    },
                    {
                        "id": "303",
                        "guild_id": "999",
                        "parent_id": "200",
                        "name": "wrong guild fixture",
                        "type": 11,
                    },
                    {
                        "id": "304",
                        "guild_id": "100",
                        "parent_id": "999",
                        "name": "wrong parent fixture",
                        "type": 11,
                    },
                ]
            }
        return {
            "threads": [
                {
                    "id": "302",
                    "guild_id": "100",
                    "parent_id": "200",
                    "name": "archived fixture",
                    "type": 11,
                    "message": "must never escape",
                    "thread_metadata": {"archived": True, "locked": True},
                },
                {
                    "id": "305",
                    "guild_id": "999",
                    "parent_id": "999",
                    "name": "wrong archived fixture",
                    "type": 11,
                },
            ]
        }

    monkeypatch.setattr(approved, "_get_bot_token", lambda: "synthetic-token")
    monkeypatch.setattr(approved, "_discord_request", request)
    _save(_job(preflight={**_job()["preflight"], "thread_id": ""}))
    tokens = _bind_cron_job("job-1")
    try:
        result = json.loads(approved._list_threads({"limit": 10}))
    finally:
        _unbind_cron_job(tokens)

    assert result["count"] == 2
    assert {row["state"] for row in result["threads"]} == {"active", "archived"}
    assert all("content" not in row and "message" not in row for row in result["threads"])
    assert all("301" not in json.dumps(row) and "302" not in json.dumps(row) for row in result["threads"])
    assert len(calls) == 3
    assert [call[1] for call in calls] == [
        "/guilds/100/threads/active",
        "/channels/200/threads/archived/public",
        "/channels/200/threads/archived/private",
    ]


def test_listing_rejects_wrong_profile_or_job_before_rest(monkeypatch):
    calls = []
    monkeypatch.setattr(approved, "_get_bot_token", lambda: "synthetic-token")
    monkeypatch.setattr(
        approved,
        "_discord_request",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )
    _save(_job())

    tokens = _bind_cron_job("missing-job")
    try:
        missing_job = json.loads(approved._list_threads({}))
    finally:
        _unbind_cron_job(tokens)
    assert "error" in missing_job

    monkeypatch.setattr("plugins.discord_scoped.get_active_profile_name", lambda: "other")
    tokens = _bind_cron_job("job-1")
    try:
        wrong_profile = json.loads(approved._list_threads({}))
    finally:
        _unbind_cron_job(tokens)
    assert "error" in wrong_profile
    assert calls == []


def test_listing_rejects_malformed_response_and_provider_failure(monkeypatch):
    monkeypatch.setattr(approved, "_get_bot_token", lambda: "synthetic-token")
    _save(_job(preflight={**_job()["preflight"], "thread_id": ""}))
    tokens = _bind_cron_job("job-1")
    try:
        monkeypatch.setattr(approved, "_discord_request", lambda *args, **kwargs: {"threads": "bad"})
        malformed = json.loads(approved._list_threads({}))
        monkeypatch.setattr(
            approved,
            "_discord_request",
            lambda *args, **kwargs: (_ for _ in ()).throw(approved.DiscordAPIError(503, "synthetic")),
        )
        failed = json.loads(approved._list_threads({}))
    finally:
        _unbind_cron_job(tokens)
    assert "error" in malformed
    assert "error" in failed


def test_cron_job_identity_has_no_environment_fallback(monkeypatch):
    from gateway.session_context import _CRON_JOB_ID, get_current_cron_job_id

    monkeypatch.setenv("HERMES_CRON_JOB_ID", "forged-by-caller")
    assert get_current_cron_job_id() == ""
    token = _CRON_JOB_ID.set("scheduler-job")
    try:
        assert get_current_cron_job_id() == "scheduler-job"
    finally:
        _CRON_JOB_ID.reset(token)


def test_no_model_send_or_approval_issuer_is_registered():
    class _Context:
        def __init__(self):
            self.tools = []

        def register_tool(self, **kwargs):
            self.tools.append(kwargs["name"])

    ctx = _Context()
    approved.register_tools(ctx)
    assert ctx.tools == ["discord_scoped_list_threads"]
    assert not hasattr(approved, "_send_approved")
    assert not hasattr(approved, "cli_command")
    assert not hasattr(approved, "register_cli")
    assert approved._check_discord_scoped_available() is False
