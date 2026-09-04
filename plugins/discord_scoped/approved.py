"""Bounded Discord thread metadata with sending intentionally unavailable.

This module deliberately lives inside the existing ``discord_scoped`` plugin.
It is not a Discord administrator surface. Listing requires a real
scheduler-bound cron context and the job's persisted exact-target policy.
Sending remains disabled because cron has no supported detached human approval
control path; a PTY or a typed phrase is not an authentication boundary.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Mapping

from tools.discord_tool import DiscordAPIError, _discord_request, _get_bot_token
from tools.registry import tool_error, tool_result

from . import _policy, _snowflake


_MAX_LIST_LIMIT = 50


LIST_THREADS_SCHEMA = {
    "name": "discord_scoped_list_threads",
    "description": (
        "List bounded active and archived Discord thread metadata for the "
        "scheduler-owned exact target. Message bodies are never returned."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": _MAX_LIST_LIMIT,
                "description": "Maximum metadata rows to return (default 20).",
            },
            "include_archived": {
                "type": "boolean",
                "description": "Include one bounded page of archived threads (default true).",
            },
        },
        "additionalProperties": False,
    },
}

def _digest(label: str, value: str) -> str:
    """Hash a scope value with domain separation before it reaches disk."""
    return hashlib.sha256(f"discord-scoped:{label}:\0{value}".encode("utf-8")).hexdigest()


def _reference(value: str) -> str:
    """Return a non-reversible short reference suitable for tool output."""
    return f"ref:{_digest('reference', value)[:16]}"


def _job_context(args: Mapping[str, Any], allowed: set[str]) -> tuple[dict[str, Any], dict[str, str], str]:
    """Resolve the scheduler-owned job and exact policy, rejecting caller identity."""
    unexpected = set(args) - allowed
    if unexpected:
        # In particular, ``job_id`` is never accepted from the model.  The
        # scheduler context is the sole source of the job identity.
        raise ValueError("unsupported Discord scoped argument")

    from gateway.session_context import _CRON_SESSION, get_current_cron_job_id

    if _CRON_SESSION.get() != "1":
        raise ValueError("trusted cron execution context is required")
    job_id = get_current_cron_job_id().strip()
    if not job_id:
        raise ValueError("trusted cron job identity is unavailable")

    from cron import jobs as cron_jobs

    job = cron_jobs.get_job(job_id)
    if not isinstance(job, dict) or str(job.get("id") or "") != job_id:
        raise ValueError("trusted cron job identity is unavailable")
    policy = _policy(job)
    return job, policy, job_id


def _coerce_list_limit(raw: Any) -> int:
    if raw is None:
        return 20
    if isinstance(raw, bool):
        raise ValueError("limit must be an integer from 1 to 50")
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("limit must be an integer from 1 to 50") from exc
    if not 1 <= value <= _MAX_LIST_LIMIT:
        raise ValueError("limit must be an integer from 1 to 50")
    return value


def _coerce_include_archived(raw: Any) -> bool:
    if raw is None:
        return True
    if not isinstance(raw, bool):
        raise ValueError("include_archived must be a boolean")
    return raw


def _bounded_metadata_value(value: Any, limit: int = 64) -> Any:
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return str(value)[:limit]


def _thread_metadata(row: Mapping[str, Any], policy: Mapping[str, str], kind: str) -> dict[str, Any] | None:
    thread_id = _snowflake(row.get("id"), "thread id")
    if str(row.get("guild_id") or "") != policy["guild_id"]:
        return None
    if str(row.get("parent_id") or "") != policy["parent_channel_id"]:
        return None
    if policy["thread_id"] and thread_id != policy["thread_id"]:
        return None
    metadata = row.get("thread_metadata")
    if not isinstance(metadata, Mapping):
        metadata = {}
    # IDs are represented as one-way references.  The model receives state and
    # names, never a raw user/channel/thread identifier or message body.
    return {
        "thread_ref": _reference(thread_id),
        "name": str(row.get("name") or "")[:120],
        "state": kind,
        "type": int(row.get("type", 0) or 0),
        "locked": bool(metadata.get("locked", row.get("locked", False))),
        "auto_archive_duration": _bounded_metadata_value(
            metadata.get("auto_archive_duration", row.get("auto_archive_duration"))
        ),
        "archive_timestamp": _bounded_metadata_value(
            metadata.get("archive_timestamp", row.get("archive_timestamp"))
        ),
        "create_timestamp": _bounded_metadata_value(row.get("create_timestamp")),
    }


def _thread_rows(payload: Any, policy: Mapping[str, str], kind: str) -> list[dict[str, Any]]:
    if not isinstance(payload, dict) or not isinstance(payload.get("threads"), list):
        raise ValueError("Discord thread response was malformed")
    result = []
    for row in payload["threads"]:
        if not isinstance(row, Mapping):
            raise ValueError("Discord thread response was malformed")
        item = _thread_metadata(row, policy, kind)
        if item is not None:
            result.append(item)
    return result


def _list_threads(args: Mapping[str, Any], **_: Any) -> str:
    try:
        _, policy, _job_id = _job_context(args, {"limit", "include_archived"})
        limit = _coerce_list_limit(args.get("limit"))
        include_archived = _coerce_include_archived(args.get("include_archived"))
        token = _get_bot_token()
        if not token:
            raise ValueError("Discord bot token is unavailable")

        # Each endpoint contributes one bounded page.  We do not follow
        # ``has_more`` cursors here: an unbounded discovery surface is outside
        # this policy edge and would make metadata disclosure difficult to cap.
        payload = _discord_request("GET", f"/guilds/{policy['guild_id']}/threads/active", token)
        rows = _thread_rows(payload, policy, "active")
        if include_archived:
            params = {"limit": "100"}
            for path in (
                f"/channels/{policy['parent_channel_id']}/threads/archived/public",
                f"/channels/{policy['parent_channel_id']}/threads/archived/private",
            ):
                archived = _discord_request("GET", path, token, params=params)
                rows.extend(_thread_rows(archived, policy, "archived"))

        # Dedupe active/private/public representations and make the result
        # deterministic without exposing the underlying Discord snowflake.
        unique: dict[str, dict[str, Any]] = {}
        for row in rows:
            unique.setdefault(row["thread_ref"], row)
        result = sorted(
            unique.values(),
            key=lambda row: (str(row.get("name") or "").casefold(), row["thread_ref"]),
        )[:limit]
        return tool_result(
            {
                "threads": result,
                "count": len(result),
                "archived_included": include_archived,
            }
        )
    except DiscordAPIError as exc:
        return tool_error(f"Discord scoped thread listing failed (HTTP {exc.status})")
    except (TypeError, ValueError):
        return tool_error("Discord scoped thread listing was denied")


def _check_discord_scoped_available() -> bool:
    try:
        from gateway.session_context import _CRON_SESSION, get_current_cron_job_id

        # Keep this model surface out of ordinary interactive turns.  The
        # scheduler binds both values before constructing the cron agent.
        if not _get_bot_token() or _CRON_SESSION.get() != "1":
            return False
        job_id = get_current_cron_job_id().strip()
        if not job_id:
            return False
        from cron import jobs as cron_jobs

        job = cron_jobs.get_job(job_id)
        _policy(job)
        return True
    except Exception:
        return False


def register_tools(ctx) -> None:
    ctx.register_tool(
        name="discord_scoped_list_threads",
        toolset="discord_scoped",
        schema=LIST_THREADS_SCHEMA,
        handler=_list_threads,
        check_fn=_check_discord_scoped_available,
        requires_env=["DISCORD_BOT_TOKEN"],
        description=LIST_THREADS_SCHEMA["description"],
        emoji="🧵",
    )
