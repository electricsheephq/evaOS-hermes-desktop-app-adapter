"""Narrow Discord policy edge; all durable state stays in the owning cron job."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from typing import Any

from hermes_cli.profiles import get_active_profile_name
from tools.discord_tool import DiscordAPIError, _discord_request, _get_bot_token

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
        max_pages = min(max(int(spec.get("max_pages", 3)), 1), 10)
        messages, before, reached_checkpoint = [], None, False
        for _page in range(max_pages):
            params = {"limit": "100"}
            if before:
                params["before"] = before
            page = _discord_request("GET", f"/channels/{target}/messages", token, params=params)
            if not isinstance(page, list):
                raise ValueError("Discord messages response was malformed")
            if not page:
                reached_checkpoint = True
                break
            ids = [_snowflake(message.get("id"), "message id") for message in page]
            messages.extend(message for message, message_id in zip(page, ids) if int(message_id) > int(checkpoint))
            if len(page) < 100 or any(int(message_id) <= int(checkpoint) for message_id in ids):
                reached_checkpoint = True
                break
            before = min(ids, key=int)
        if not reached_checkpoint:
            raise ValueError("Discord backlog exceeds bounded pagination; checkpoint unchanged")
        human = sorted(
            (message for message in messages if not (message.get("author") or {}).get("bot")),
            key=lambda message: int(message["id"]),
        )[:limit]
        if not human:
            return {"provider": PROVIDER, "action": "silent"}
        next_checkpoint = str(human[-1]["id"])
        return {
            "provider": PROVIDER,
            "action": "continue",
            "context": json.dumps({"discord_messages": human}, separators=(",", ":")),
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
                prior = _snowflake(receipt.get("prior"), "prior checkpoint")
                next_checkpoint = _snowflake(receipt.get("next"), "checkpoint")
                if int(next_checkpoint) < int(prior):
                    raise ValueError("Discord checkpoint cannot regress")
                spec["checkpoint"] = next_checkpoint
                jobs[index] = {**current, "preflight": spec}
                cron_jobs.save_jobs(jobs)
                return {"provider": PROVIDER, "ok": True}
        raise ValueError("owning cron job no longer exists")
    except (TypeError, ValueError):
        return {"provider": PROVIDER, "ok": False}


def register(ctx) -> None:
    ctx.register_hook("cron_preflight", _preflight)
    ctx.register_hook("cron_preflight_commit", _commit)
    from .approved import register_tools

    register_tools(ctx)


# Keep the metadata handler importable from the plugin package for focused
# tests and downstream plugin diagnostics.
from .approved import _list_threads  # noqa: E402,F401
