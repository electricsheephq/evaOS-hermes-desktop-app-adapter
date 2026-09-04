import json
import time
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
                    }
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
                }
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


def test_approved_send_claims_once_and_stores_only_digests(monkeypatch):
    calls = []

    def request(method, path, _token, params=None, body=None):
        calls.append((method, path, params, body))
        if method == "GET":
            return {
                "id": "300",
                "guild_id": "100",
                "parent_id": "200",
                "type": 11,
                "thread_metadata": {"archived": False, "locked": False},
            }
        return {"id": "900", "content": body["content"]}

    monkeypatch.setattr(approved, "_get_bot_token", lambda: "synthetic-token")
    monkeypatch.setattr(approved, "_discord_request", request)
    _save(_job())
    issued = approved._issue_approval(
        job_id="job-1",
        destination="300",
        message="synthetic approved payload",
    )
    assert issued == {"ok": True, "expires_in": 300}

    tokens = _bind_cron_job("job-1")
    try:
        first = json.loads(
            approved._send_approved(
                {"destination": "300", "message": "synthetic approved payload"}
            )
        )
        replay = json.loads(
            approved._send_approved(
                {"destination": "300", "message": "synthetic approved payload"}
            )
        )
    finally:
        _unbind_cron_job(tokens)

    assert first["sent"] is True
    assert "error" in replay
    assert len(calls) == 2
    assert [call[0:2] for call in calls] == [
        ("GET", "/channels/300"),
        ("POST", "/channels/300/messages"),
    ]
    assert calls[1][3] == {"content": "synthetic approved payload"}
    receipt_text = approved._approval_path().read_text(encoding="utf-8")
    assert "synthetic approved payload" not in receipt_text
    assert "job-1" not in receipt_text
    assert '"destination_digest"' in receipt_text
    assert '"nonce_digest"' in receipt_text


def test_approved_send_rejects_locked_or_archived_target_before_post(monkeypatch):
    calls = []
    state = {"locked": True, "archived": False}

    def request(method, path, _token, params=None, body=None):
        calls.append((method, path, params, body))
        if method == "GET":
            return {
                "id": "300",
                "guild_id": "100",
                "parent_id": "200",
                "type": 11,
                "thread_metadata": dict(state),
            }
        return {"id": "900"}

    monkeypatch.setattr(approved, "_get_bot_token", lambda: "synthetic-token")
    monkeypatch.setattr(approved, "_discord_request", request)
    _save(_job())
    tokens = _bind_cron_job("job-1")
    try:
        for message, next_state in (
            ("synthetic locked payload", {"locked": True, "archived": False}),
            ("synthetic archived payload", {"locked": False, "archived": True}),
        ):
            state.update(next_state)
            approved._issue_approval(
                job_id="job-1", destination="300", message=message
            )
            result = json.loads(
                approved._send_approved({"destination": "300", "message": message})
            )
            assert "error" in result
    finally:
        _unbind_cron_job(tokens)

    assert [call[0:2] for call in calls] == [
        ("GET", "/channels/300"),
        ("GET", "/channels/300"),
    ]


def test_approved_send_rejects_missing_context_and_all_binding_mismatches(monkeypatch):
    calls = []
    monkeypatch.setattr(approved, "_get_bot_token", lambda: "synthetic-token")
    monkeypatch.setattr(approved, "_discord_request", lambda *args, **kwargs: calls.append(args))
    cron_jobs.save_jobs([_job(), {**_job(), "id": "job-2"}])
    approved._issue_approval(
        job_id="job-1", destination="300", message="synthetic exact payload"
    )

    # No scheduler context: the handler rejects before even reading a token or
    # touching Discord REST.
    assert "error" in json.loads(
        approved._send_approved(
            {"destination": "300", "message": "synthetic exact payload"}
        )
    )

    tokens = _bind_cron_job("job-1")
    try:
        assert "error" in json.loads(
            approved._send_approved(
                {"destination": "999", "message": "synthetic exact payload"}
            )
        )
        assert "error" in json.loads(
            approved._send_approved(
                {"destination": "300", "message": "synthetic changed payload"}
            )
        )
        assert "error" in json.loads(
            approved._send_approved(
                {
                    "destination": "300",
                    "message": "synthetic exact payload",
                    "job_id": "job-1",
                }
            )
        )
        monkeypatch.setattr("plugins.discord_scoped.get_active_profile_name", lambda: "other")
        assert "error" in json.loads(
            approved._send_approved(
                {"destination": "300", "message": "synthetic exact payload"}
            )
        )
        monkeypatch.setattr("plugins.discord_scoped.get_active_profile_name", lambda: "custom")
    finally:
        _unbind_cron_job(tokens)

    tokens = _bind_cron_job("job-2")
    try:
        assert "error" in json.loads(
            approved._send_approved(
                {"destination": "300", "message": "synthetic exact payload"}
            )
        )
    finally:
        _unbind_cron_job(tokens)

    assert calls == []


def test_expired_approval_fails_closed_before_rest(monkeypatch):
    calls = []
    monkeypatch.setattr(approved, "_get_bot_token", lambda: "synthetic-token")
    monkeypatch.setattr(approved, "_discord_request", lambda *args, **kwargs: calls.append(args))
    _save(_job())
    approved._issue_approval(
        job_id="job-1", destination="300", message="synthetic expiring payload"
    )
    now = time.time()
    monkeypatch.setattr(approved.time, "time", lambda: now + 301)
    tokens = _bind_cron_job("job-1")
    try:
        result = json.loads(
            approved._send_approved(
                {"destination": "300", "message": "synthetic expiring payload"}
            )
        )
    finally:
        _unbind_cron_job(tokens)
    assert "error" in result
    assert calls == []


def test_cron_job_identity_has_no_environment_fallback(monkeypatch):
    from gateway.session_context import _CRON_JOB_ID, get_current_cron_job_id

    monkeypatch.setenv("HERMES_CRON_JOB_ID", "forged-by-caller")
    assert get_current_cron_job_id() == ""
    token = _CRON_JOB_ID.set("scheduler-job")
    try:
        assert get_current_cron_job_id() == "scheduler-job"
    finally:
        _CRON_JOB_ID.reset(token)


def test_approval_cli_is_human_only_and_tools_do_not_expose_issuer(monkeypatch, capsys):
    class _TTY:
        def isatty(self):
            return False

    args = type(
        "Args",
        (),
        {
            "discord_scoped_command": "approve",
            "job_id": "job-1",
            "destination": "300",
            "message": "synthetic",
            "ttl_seconds": 300,
        },
    )()
    monkeypatch.setattr(approved.sys, "stdin", _TTY())
    assert approved.cli_command(args) == 2
    assert "interactive human terminal" in capsys.readouterr().out

    class _Context:
        def __init__(self):
            self.tools = []

        def register_tool(self, **kwargs):
            self.tools.append(kwargs["name"])

    ctx = _Context()
    approved.register_tools(ctx)
    assert ctx.tools == [
        "discord_scoped_list_threads",
        "discord_scoped_send_approved",
    ]
    assert "approve" not in ctx.tools
    assert approved._check_discord_scoped_available() is False
