"""Narrow Discord policy edge; all durable state stays in the owning cron job."""

from __future__ import annotations

import hashlib
import json
import time
from collections.abc import Mapping
from typing import Any

from hermes_cli.profiles import get_active_profile_name
from tools.discord_tool import DiscordAPIError, _discord_request, _get_bot_token
from tools.registry import tool_error

PROVIDER = "discord_scoped"
_THREAD_TYPES = {10, 11, 12}


def _snowflake(value: Any, field: str) -> str:
    value = str(value or "")
    if not value.isdigit() or len(value) > 20:
        raise ValueError(f"{field} must be a Discord snowflake")
    return value


def _policy(job: Mapping[str, Any]) -> dict[str, Any]:
    spec = job.get("preflight")
    if not isinstance(spec, Mapping) or spec.get("provider") != PROVIDER:
        raise ValueError("missing discord_scoped preflight policy")
    policy = {
        "profile": str(spec.get("profile") or ""),
        "guild_id": _snowflake(spec.get("guild_id"), "guild_id"),
        "parent_channel_id": _snowflake(spec.get("parent_channel_id"), "parent_channel_id"),
        "thread_id": (
            _snowflake(spec.get("thread_id"), "thread_id")
            if spec.get("thread_id") else ""
        ),
    }
    if not policy["profile"] or policy["profile"] != get_active_profile_name():
        raise ValueError("preflight profile does not match the active profile")
    return policy


def _policy_hash(policy: Mapping[str, Any]) -> str:
    raw = json.dumps(dict(policy), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode()).hexdigest()


def _validate_channel(token: str, policy: Mapping[str, Any], channel_id: str) -> dict:
    channel = _discord_request("GET", f"/channels/{channel_id}", token)
    if str(channel.get("guild_id") or "") != policy["guild_id"]:
        raise ValueError("Discord channel guild does not match policy")
    if policy["thread_id"]:
        if int(channel.get("type", -1)) not in _THREAD_TYPES:
            raise ValueError("policy thread_id is not a Discord thread")
        if str(channel.get("parent_id") or "") != policy["parent_channel_id"]:
            raise ValueError("Discord thread parent does not match policy")
    elif str(channel.get("id") or "") != policy["parent_channel_id"]:
        raise ValueError("Discord parent channel does not match policy")
    return channel


def _preflight(*, provider: str, job: Mapping[str, Any], **_: Any):
    if provider != PROVIDER:
        return None
    try:
        policy = _policy(job)
        spec = job["preflight"]
        token = _get_bot_token()
        if not token:
            raise ValueError("Discord bot token is unavailable")
        target = policy["thread_id"] or policy["parent_channel_id"]
        _validate_channel(token, policy, target)
        checkpoint = str(spec.get("checkpoint") or "")
        if checkpoint:
            _snowflake(checkpoint, "checkpoint")
        limit = min(max(int(spec.get("limit", 50)), 1), 100)
        params = {"limit": str(limit)}
        if checkpoint:
            params["after"] = checkpoint
        messages = _discord_request("GET", f"/channels/{target}/messages", token, params=params)
        if not isinstance(messages, list):
            raise ValueError("Discord messages response was malformed")
        if not messages:
            return {"provider": PROVIDER, "action": "silent"}
        next_checkpoint = max(
            (_snowflake(m.get("id"), "message id") for m in messages), key=int
        )
        return {
            "provider": PROVIDER,
            "action": "continue",
            "context": json.dumps({"discord_messages": messages}, separators=(",", ":")),
            "receipt": {
                "job_id": str(job.get("id") or ""),
                "prior": checkpoint,
                "next": next_checkpoint,
                "policy_hash": _policy_hash(policy),
            },
        }
    except (DiscordAPIError, TypeError, ValueError) as exc:
        return {"provider": PROVIDER, "action": "error", "error": str(exc)}


def _commit(*, provider: str, job: Mapping[str, Any], receipt: Mapping[str, Any], **_: Any):
    if provider != PROVIDER:
        return None
    from cron import jobs as cron_jobs

    try:
        with cron_jobs._jobs_lock():
            jobs = cron_jobs.load_jobs()
            for index, current in enumerate(jobs):
                if current.get("id") != receipt.get("job_id"):
                    continue
                policy = _policy(current)
                spec = dict(current["preflight"])
                if _policy_hash(policy) != receipt.get("policy_hash"):
                    raise ValueError("Discord preflight policy changed before checkpoint commit")
                if str(spec.get("checkpoint") or "") != receipt.get("prior"):
                    raise ValueError("Discord checkpoint changed before commit")
                spec["checkpoint"] = _snowflake(receipt.get("next"), "checkpoint")
                jobs[index] = {**current, "preflight": spec}
                cron_jobs.save_jobs(jobs)
                return {"provider": PROVIDER, "ok": True}
        raise ValueError("owning cron job no longer exists")
    except (TypeError, ValueError):
        return {"provider": PROVIDER, "ok": False}


def _job_policy(job_id: str) -> tuple[dict, dict]:
    from cron.jobs import get_job

    job = get_job(str(job_id or ""))
    if not job:
        raise ValueError("owning cron job was not found")
    return job, _policy(job)


def _thread_metadata(thread: Mapping[str, Any]) -> dict[str, Any]:
    meta = thread.get("thread_metadata") or {}
    archived, locked = bool(meta.get("archived")), bool(meta.get("locked"))
    return {
        "id": str(thread.get("id") or ""),
        "name": str(thread.get("name") or ""),
        "guild_id": str(thread.get("guild_id") or ""),
        "parent_id": str(thread.get("parent_id") or ""),
        "type": int(thread.get("type", -1)),
        "state": "locked" if locked else ("archived" if archived else "active"),
        "archived": archived,
        "locked": locked,
        "archive_timestamp": meta.get("archive_timestamp"),
    }


def _list_threads(args: dict, **_: Any) -> str:
    try:
        _, policy = _job_policy(args.get("job_id"))
        token = _get_bot_token()
        if not token:
            raise ValueError("Discord bot token is unavailable")
        parent = policy["parent_channel_id"]
        limit = min(max(int(args.get("limit", 100)), 1), 100)
        max_pages = min(max(int(args.get("max_pages", 2)), 1), 3)
        found: list[dict] = []
        active = _discord_request("GET", f"/guilds/{policy['guild_id']}/threads/active", token)
        found.extend(active.get("threads") or [])
        for kind in ("public", "private"):
            before = None
            for _page in range(max_pages):
                params = {"limit": str(limit)}
                if before:
                    params["before"] = before
                page = _discord_request("GET", f"/channels/{parent}/threads/archived/{kind}", token, params=params)
                threads = page.get("threads") or []
                found.extend(threads)
                if not page.get("has_more") or not threads:
                    break
                before = (threads[-1].get("thread_metadata") or {}).get("archive_timestamp")
                if not before:
                    break
        rows = [
            _thread_metadata(t) for t in found
            if str(t.get("guild_id") or "") == policy["guild_id"]
            and str(t.get("parent_id") or "") == parent
        ]
        unique = {row["id"]: row for row in rows}
        return json.dumps({"threads": list(unique.values())[:limit], "count": min(len(unique), limit)})
    except (DiscordAPIError, TypeError, ValueError) as exc:
        return tool_error(str(exc))


def _claim_approval(job_id: str, approval_id: str, nonce: str, destination: str, message: str) -> dict:
    from cron import jobs as cron_jobs

    digest = hashlib.sha256(message.encode()).hexdigest()
    with cron_jobs._jobs_lock():
        jobs = cron_jobs.load_jobs()
        for index, job in enumerate(jobs):
            if job.get("id") != job_id:
                continue
            policy = _policy(job)
            approvals = list(job.get("discord_approvals") or [])
            for pos, approval in enumerate(approvals):
                if str(approval.get("id") or "") != approval_id:
                    continue
                expected = {
                    "profile": policy["profile"], "destination_id": destination,
                    "message_sha256": digest, "nonce": nonce,
                }
                if approval.get("used_at") or any(str(approval.get(k) or "") != v for k, v in expected.items()):
                    raise ValueError("approval is used or does not match this exact send")
                if float(approval.get("expires_at", 0)) <= time.time():
                    raise ValueError("approval has expired")
                approval = dict(approval)
                approval["used_at"] = time.time()
                approvals[pos] = approval
                jobs[index] = {**job, "discord_approvals": approvals}
                cron_jobs.save_jobs(jobs)
                return approval
        raise ValueError("approval was not found")


def _send_approved(args: dict, **_: Any) -> str:
    try:
        job_id = str(args.get("job_id") or "")
        destination = _snowflake(args.get("destination_id"), "destination_id")
        message = str(args.get("message") or "")
        if not message:
            raise ValueError("message is required")
        job, policy = _job_policy(job_id)
        approval_id, nonce = str(args.get("approval_id") or ""), str(args.get("nonce") or "")
        approvals = job.get("discord_approvals") or []
        approval = next((a for a in approvals if str(a.get("id") or "") == approval_id), None)
        if not approval:
            raise ValueError("approval was not found")
        digest = hashlib.sha256(message.encode()).hexdigest()
        if str(approval.get("destination_id") or "") != destination or str(approval.get("message_sha256") or "") != digest or str(approval.get("nonce") or "") != nonce:
            raise ValueError("approval does not match this exact send")
        if approval.get("used_at"):
            raise ValueError("approval has already been used")
        if float(approval.get("expires_at", 0)) <= time.time():
            raise ValueError("approval has expired")
        token = _get_bot_token()
        if not token:
            raise ValueError("Discord bot token is unavailable")
        channel = _validate_channel(token, {**policy, "thread_id": destination if destination != policy["parent_channel_id"] else ""}, destination)
        meta = channel.get("thread_metadata") or {}
        if (meta.get("archived") or meta.get("locked")) and not approval.get("allow_archived_locked"):
            raise ValueError("archived or locked destination is not approved")
        _claim_approval(job_id, approval_id, nonce, destination, message)
        _discord_request("POST", f"/channels/{destination}/messages", token, body={"content": message})
        return json.dumps({"success": True, "approval_id": approval_id})
    except (DiscordAPIError, TypeError, ValueError) as exc:
        return tool_error(str(exc))


_LIST_SCHEMA = {"type": "function", "function": {"name": "discord_scoped_list_threads", "description": "List bounded metadata for active and archived threads under one job-approved Discord parent.", "parameters": {"type": "object", "properties": {"job_id": {"type": "string"}, "limit": {"type": "integer", "minimum": 1, "maximum": 100}, "max_pages": {"type": "integer", "minimum": 1, "maximum": 3}}, "required": ["job_id"]}}}
_SEND_SCHEMA = {"type": "function", "function": {"name": "discord_scoped_send_approved", "description": "Send once to the exact Discord destination and message bound by an existing approval.", "parameters": {"type": "object", "properties": {"job_id": {"type": "string"}, "approval_id": {"type": "string"}, "nonce": {"type": "string"}, "destination_id": {"type": "string"}, "message": {"type": "string"}}, "required": ["job_id", "approval_id", "nonce", "destination_id", "message"]}}}


def _available() -> bool:
    if not _get_bot_token():
        return False
    from cron.jobs import list_jobs
    return any((job.get("preflight") or {}).get("provider") == PROVIDER for job in list_jobs(include_disabled=True))


def register(ctx) -> None:
    ctx.register_hook("cron_preflight", _preflight)
    ctx.register_hook("cron_preflight_commit", _commit)
    ctx.register_tool("discord_scoped_list_threads", "discord_scoped", _LIST_SCHEMA, _list_threads, check_fn=_available)
    ctx.register_tool("discord_scoped_send_approved", "discord_scoped", _SEND_SCHEMA, _send_approved, check_fn=_available)
