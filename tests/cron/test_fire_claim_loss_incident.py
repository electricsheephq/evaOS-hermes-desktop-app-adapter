"""sc#1057: fire-claim loss must be visible, and a restart-safe worker must keep its fire claim.

1. Every path that terminates an execution because the fire claim was lost (not acquired, lost
   before start, lost mid-run with the result discarded) records a ``cron_incidents`` row, like
   any other failed run. Before, these wrote only ``executions.error`` and opened no incident.
2. The fire claim is stamped ``host:<gateway pid>:<token>`` by the gateway tick that dispatched
   the run. The restart-safe external worker survives a gateway restart, but the dead-owner
   shortcut (``_claim_owner_is_dead``) released the claim as soon as that gateway pid exited, so
   the replacement gateway's next tick re-claimed the job and the live worker's result was
   discarded ("Fire claim ownership lost; stale result was discarded."). The worker now moves the
   claim to its own pid when it adopts the execution.

These drive the real stores (``jobs.json`` + ``executions.db`` under a temp HERMES_HOME).
"""

from __future__ import annotations

import json
import socket
import subprocess
import sys
from datetime import datetime, timedelta, timezone

import pytest


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    return tmp_path


@pytest.fixture(autouse=True)
def _clean_running_state():
    import cron.scheduler as sched

    sched._running_job_ids.clear()
    sched._running_fire_owners.clear()
    yield
    sched._running_job_ids.clear()
    sched._running_fire_owners.clear()


def _incidents_for(job_id):
    from cron.incidents import list_incidents

    return [i for i in list_incidents() if i["job_id"] == job_id]


def _job_with_live_claim():
    from cron.jobs import claim_job_for_fire, create_job, get_job

    job = create_job(prompt="x", schedule="every 5m", name="sc1057")
    assert claim_job_for_fire(job["id"]) is True
    return get_job(job["id"])


def test_fire_claim_not_acquired_opens_incident(home):
    import cron.scheduler as sched
    from cron.executions import create_execution, get_execution

    job = _job_with_live_claim()  # another run holds the claim
    execution = create_execution(job["id"], source="builtin")

    assert sched._process_due_job(dict(job, execution_id=execution["id"]), None, None, False) is True

    row = get_execution(execution["id"])
    assert row["status"] == "failed"
    assert row["error"] == "Fire claim lost; execution was not started."
    incidents = _incidents_for(job["id"])
    assert len(incidents) == 1
    assert incidents[0]["error"] == "Fire claim lost; execution was not started."


def test_fire_claim_lost_before_start_opens_incident(home):
    import cron.scheduler as sched
    from cron.executions import create_execution, get_execution

    job = _job_with_live_claim()
    execution = create_execution(job["id"], source="builtin")
    stale = dict(job, execution_id=execution["id"])
    stale["fire_claim"] = dict(job["fire_claim"], by="another-host:1:stale")
    ran = []

    assert sched._run_with_fire_claim_heartbeat(stale, lambda _lost: ran.append(1) or True) is True

    assert ran == []
    assert get_execution(execution["id"])["status"] == "failed"
    assert len(_incidents_for(job["id"])) == 1


def test_discarded_stale_result_opens_incident(home):
    import cron.scheduler as sched
    from cron.executions import create_execution, get_execution

    job = _job_with_live_claim()
    execution = create_execution(job["id"], source="builtin")

    sched._record_fire_ownership_lost(job["id"], "another-host:1:stale", execution["id"])

    row = get_execution(execution["id"])
    assert row["error"] == "Fire claim ownership lost; stale result was discarded."
    incidents = _incidents_for(job["id"])
    assert len(incidents) == 1
    assert incidents[0]["error"] == "Fire claim ownership lost; stale result was discarded."


def test_restart_safe_worker_keeps_fire_claim_after_dispatching_gateway_exits(home, monkeypatch):
    import cron.jobs as jobs
    import cron.scheduler as sched
    from cron.executions import create_execution, mark_execution_handoff_pending

    # The gateway that ticked and claimed this fire, then exited (a unit restart).
    gateway = subprocess.Popen([sys.executable, "-c", "pass"])
    gateway.wait()
    real_machine_id = jobs._machine_id
    monkeypatch.setattr(jobs, "_machine_id", lambda: f"{socket.gethostname()}:{gateway.pid}")
    job = jobs.create_job(prompt="x", schedule="every 5m", name="sc1057-restart")
    claimed = jobs.claim_job_for_fire(job["id"], return_job=True)
    assert claimed
    monkeypatch.setattr(jobs, "_machine_id", real_machine_id)

    execution = create_execution(job["id"], source="builtin")
    assert mark_execution_handoff_pending(execution["id"]) is not None
    payload = home / "payload.json"
    ack = home / "exec.ready"
    payload.write_text(
        json.dumps({"job": dict(claimed, execution_id=execution["id"]), "profile_home": str(home)}),
        encoding="utf-8",
    )
    seen = {}

    def fake_run_one_job(running_job, **_kwargs):
        # The replacement gateway's tick tries to fire the same job while this worker runs.
        seen["replacement_claimed"] = jobs.claim_job_for_fire(running_job["id"])
        seen["worker_owner"] = running_job["fire_claim"]["by"]
        seen["store_owner"] = jobs.get_job(running_job["id"])["fire_claim"]["by"]
        seen["worker_heartbeat"] = jobs.heartbeat_fire_claim(
            running_job["id"], expected_owner=running_job["fire_claim"]["by"])
        return True

    monkeypatch.setattr(sched, "run_one_job", fake_run_one_job)

    assert sched._run_external_worker_payload(payload, ack) is True

    assert seen["replacement_claimed"] is False
    assert seen["worker_owner"] == seen["store_owner"]
    assert seen["worker_heartbeat"] is True


def test_oneshot_worker_keeps_both_claims_after_dispatching_gateway_exits(home, monkeypatch):
    import cron.jobs as jobs
    import cron.scheduler as sched
    from cron.executions import create_execution, mark_execution_handoff_pending

    gateway = subprocess.Popen([sys.executable, "-c", "pass"])
    gateway.wait()
    now = datetime.now(timezone.utc)
    monkeypatch.setattr(jobs, "_hermes_now", lambda: now)
    monkeypatch.setattr(sched, "_hermes_now", lambda: now)
    real_machine_id = jobs._machine_id
    monkeypatch.setattr(jobs, "_machine_id", lambda: f"{socket.gethostname()}:{gateway.pid}")
    job = jobs.create_job(prompt="x", schedule=now.isoformat(), name="sc1057-once-restart")
    assert [due["id"] for due in jobs.get_due_jobs()] == [job["id"]]
    claimed = jobs.claim_job_for_fire(job["id"], return_job=True)
    assert claimed
    assert jobs.claim_dispatch(job["id"]) is True
    assert jobs.get_job(job["id"])["repeat"]["completed"] == 1
    monkeypatch.setattr(jobs, "_machine_id", real_machine_id)
    now += timedelta(seconds=10)

    execution = create_execution(job["id"], source="builtin")
    assert mark_execution_handoff_pending(execution["id"]) is not None
    payload = home / "payload.json"
    ack = home / "exec.ready"
    payload.write_text(
        json.dumps({"job": dict(claimed, execution_id=execution["id"]), "profile_home": str(home)}),
        encoding="utf-8",
    )

    def fake_run_one_job(running_job, **_kwargs):
        # No process-local running registration: this is the replacement gateway's scan.
        assert jobs.get_due_jobs() == []
        stored = jobs.get_job(running_job["id"])
        assert stored is not None, "replacement gateway retired the live worker's one-shot"
        owner = running_job["fire_claim"]["by"]
        assert owner != claimed["fire_claim"]["by"]
        assert running_job["run_claim"]["by"] == stored["run_claim"]["by"] == owner
        assert stored["fire_claim"]["by"] == owner
        for claim_name in ("run_claim", "fire_claim"):
            assert datetime.fromisoformat(stored[claim_name]["at"]) == now
            assert datetime.fromisoformat(running_job[claim_name]["at"]) >= now
        assert jobs.heartbeat_run_claim(running_job["id"], expected_owner=owner) is True
        assert jobs.heartbeat_fire_claim(running_job["id"], expected_owner=owner) is True
        assert jobs.mark_job_run(running_job["id"], True, expected_fire_owner=owner) is True
        completed = jobs.get_job(running_job["id"])
        assert completed["state"] == "completed"
        assert completed["run_claim"] is None
        assert completed["fire_claim"] is None
        return True

    monkeypatch.setattr(sched, "run_one_job", fake_run_one_job)

    assert sched._run_external_worker_payload(payload, ack) is True


def test_transfer_fire_claim_preserves_mismatched_run_claim(home, monkeypatch):
    import cron.jobs as jobs

    now = datetime.now(timezone.utc)
    monkeypatch.setattr(jobs, "_hermes_now", lambda: now)
    job = jobs.create_job(prompt="x", schedule=now.isoformat(), name="sc1057-owner-mismatch")
    assert [due["id"] for due in jobs.get_due_jobs()] == [job["id"]]
    claimed = jobs.claim_job_for_fire(job["id"], return_job=True)
    assert claimed
    run_claim = dict(claimed["run_claim"])
    now += timedelta(seconds=10)

    new_owner = jobs.transfer_fire_claim(
        job["id"], expected_owner=claimed["fire_claim"]["by"],
        expected_run_owner="another-host:1:stale",
    )

    assert new_owner and new_owner != claimed["fire_claim"]["by"]
    stored = jobs.get_job(job["id"])
    assert stored["fire_claim"] == {"by": new_owner, "at": now.isoformat()}
    assert stored["run_claim"] == run_claim
    # A failed fire CAS must leave even a matching run claim untouched.
    assert jobs.transfer_fire_claim(
        job["id"], expected_owner=claimed["fire_claim"]["by"],
        expected_run_owner=run_claim["by"],
    ) is None
    assert jobs.get_job(job["id"]) == stored
    # Omitting the optional owner preserves the legacy fire-only transfer.
    assert jobs.transfer_fire_claim(job["id"], expected_owner=new_owner)
    assert jobs.get_job(job["id"])["run_claim"] == run_claim
