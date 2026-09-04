"""Bounded Discord thread metadata and human-approved one-shot sends.

This module deliberately lives inside the existing ``discord_scoped`` plugin.
It is not a Discord administrator surface: both model-facing tools require a
real scheduler-bound cron context and the job's persisted exact-target policy.
Human approval receipts contain digests only, so the local receipt store never
becomes a second source of customer identifiers or message content.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import secrets
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Mapping

from hermes_constants import get_hermes_home
from tools.discord_tool import DiscordAPIError, _discord_request, _get_bot_token
from tools.registry import tool_error, tool_result
from utils import atomic_json_write

from . import _THREAD_TYPES, _policy, _snowflake


_MAX_MESSAGE_LENGTH = 2_000
_MAX_LIST_LIMIT = 50
_DEFAULT_APPROVAL_TTL = 300
_MIN_APPROVAL_TTL = 30
_MAX_APPROVAL_TTL = 3_600
_APPROVAL_FILE = "discord_scoped_approvals.json"
_APPROVAL_SCHEMA_VERSION = 1


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

SEND_APPROVED_SCHEMA = {
    "name": "discord_scoped_send_approved",
    "description": (
        "Send one exact-target Discord message only when a human-issued, "
        "unexpired approval matches this cron job, destination, and message."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "destination": {
                "type": "string",
                "description": "Exact channel or thread snowflake approved by the operator.",
            },
            "message": {
                "type": "string",
                "maxLength": _MAX_MESSAGE_LENGTH,
                "description": "Exact message text approved by the operator.",
            },
        },
        "required": ["destination", "message"],
        "additionalProperties": False,
    },
}


def _approval_path() -> Path:
    """Return the active profile's private, cron-local approval receipt path."""
    return Path(get_hermes_home()).expanduser().resolve() / "cron" / _APPROVAL_FILE


def _digest(label: str, value: str) -> str:
    """Hash a scope value with domain separation before it reaches disk."""
    return hashlib.sha256(f"discord-scoped:{label}:\0{value}".encode("utf-8")).hexdigest()


def _message_hash(message: str) -> str:
    return hashlib.sha256(message.encode("utf-8")).hexdigest()


def _reference(value: str) -> str:
    """Return a non-reversible short reference suitable for tool output."""
    return f"ref:{_digest('reference', value)[:16]}"


@contextmanager
def _approval_store_lock() -> Iterator[None]:
    """Serialize approval claim/issue with the existing cross-process cron lock."""
    from cron import jobs as cron_jobs

    with cron_jobs._jobs_lock():
        yield


def _load_approvals() -> list[dict[str, Any]]:
    path = _approval_path()
    if not path.exists():
        return []
    try:
        with path.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError) as exc:
        raise ValueError("Discord approval receipt store is unavailable") from exc
    records = payload.get("approvals") if isinstance(payload, dict) else None
    if not isinstance(records, list) or any(not isinstance(row, dict) for row in records):
        raise ValueError("Discord approval receipt store is malformed")
    return [dict(row) for row in records]


def _save_approvals(records: list[dict[str, Any]]) -> None:
    # 0600 is intentional: the file is an authorization receipt store even
    # though it contains only digests and no bearer values.
    atomic_json_write(
        _approval_path(),
        {"version": _APPROVAL_SCHEMA_VERSION, "approvals": records},
        mode=0o600,
    )


def _validate_record(record: Mapping[str, Any]) -> None:
    required = {
        "profile_digest",
        "job_digest",
        "destination_digest",
        "message_sha256",
        "nonce_digest",
        "issued_at",
        "expires_at",
        "used_at",
    }
    if set(record) != required:
        raise ValueError("Discord approval receipt store is malformed")
    for field in (
        "profile_digest",
        "job_digest",
        "destination_digest",
        "message_sha256",
        "nonce_digest",
    ):
        value = record.get(field)
        if not isinstance(value, str) or len(value) != 64:
            raise ValueError("Discord approval receipt store is malformed")
        try:
            int(value, 16)
        except ValueError as exc:
            raise ValueError("Discord approval receipt store is malformed") from exc
    try:
        issued_at = float(record["issued_at"])
        expires_at = float(record["expires_at"])
    except (TypeError, ValueError, KeyError) as exc:
        raise ValueError("Discord approval receipt store is malformed") from exc
    if expires_at <= issued_at or record.get("used_at") is not None and not isinstance(
        record.get("used_at"), (int, float)
    ):
        raise ValueError("Discord approval receipt store is malformed")


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


def _message_args(args: Mapping[str, Any]) -> tuple[str, str]:
    destination = _snowflake(args.get("destination"), "destination")
    message = args.get("message")
    if not isinstance(message, str) or not message.strip():
        raise ValueError("message is required")
    if len(message) > _MAX_MESSAGE_LENGTH:
        raise ValueError("message exceeds Discord's 2000 character limit")
    return destination, message


def _validate_send_target(
    token: str, policy: Mapping[str, str], destination: str
) -> None:
    """Re-read target state before POST, without exposing provider payloads."""
    channel = _discord_request("GET", f"/channels/{destination}", token)
    if not isinstance(channel, Mapping):
        raise ValueError("Discord target response was malformed")
    if str(channel.get("guild_id") or "") != policy["guild_id"]:
        raise ValueError("Discord target guild does not match policy")
    if policy["thread_id"]:
        if str(channel.get("id") or "") != destination:
            raise ValueError("Discord target does not match policy")
        if int(channel.get("type", -1)) not in _THREAD_TYPES:
            raise ValueError("Discord target is not a thread")
        if str(channel.get("parent_id") or "") != policy["parent_channel_id"]:
            raise ValueError("Discord target parent does not match policy")
    elif str(channel.get("id") or "") != policy["parent_channel_id"]:
        raise ValueError("Discord parent does not match policy")
    metadata = channel.get("thread_metadata")
    if not isinstance(metadata, Mapping):
        metadata = {}
    if bool(metadata.get("locked", channel.get("locked", False))):
        raise ValueError("Discord target is locked")
    if bool(metadata.get("archived", channel.get("archived", False))):
        raise ValueError("Discord target is archived")


def _claim_approval(
    *,
    profile: str,
    job_id: str,
    destination: str,
    message: str,
    now: float,
) -> None:
    expected = {
        "profile_digest": _digest("profile", profile),
        "job_digest": _digest("job", job_id),
        "destination_digest": _digest("destination", destination),
        "message_sha256": _message_hash(message),
    }
    with _approval_store_lock():
        records = _load_approvals()
        matches = []
        for index, record in enumerate(records):
            _validate_record(record)
            if any(record.get(key) != value for key, value in expected.items()):
                continue
            if record.get("used_at") is not None:
                continue
            if float(record["expires_at"]) <= now:
                continue
            matches.append(index)
        if len(matches) != 1:
            raise ValueError("no matching unexpired Discord approval exists")
        records[matches[0]]["used_at"] = now
        _save_approvals(records)


def _send_approved(args: Mapping[str, Any], **_: Any) -> str:
    try:
        _, policy, job_id = _job_context(args, {"destination", "message"})
        destination, message = _message_args(args)
        expected_destination = policy["thread_id"] or policy["parent_channel_id"]
        if destination != expected_destination:
            raise ValueError("destination does not match the exact cron policy")

        token = _get_bot_token()
        if not token:
            raise ValueError("Discord bot token is unavailable")

        # Claim before the first Discord REST call. A replay, expiry, or any
        # other authorization mismatch therefore fails closed without
        # touching the provider, and concurrent sends cannot reuse the same
        # receipt. A provider-state rejection consumes the one-shot too, so
        # a later retry requires a fresh human decision.
        _claim_approval(
            profile=policy["profile"],
            job_id=job_id,
            destination=destination,
            message=message,
            now=time.time(),
        )
        # Re-read target state only after authorization is durably consumed;
        # locked or archived targets fail before the POST transport step.
        _validate_send_target(token, policy, destination)
        _discord_request(
            "POST",
            f"/channels/{destination}/messages",
            token,
            body={"content": message},
        )
        return tool_result(
            {
                "sent": True,
                "destination_ref": _reference(destination),
                "message_sha256": _message_hash(message),
            }
        )
    except DiscordAPIError as exc:
        # The receipt is intentionally consumed before REST.  A failed
        # provider request must be re-approved rather than retried by replay.
        return tool_error(f"Discord scoped send failed (HTTP {exc.status}); approval was consumed")
    except (TypeError, ValueError):
        return tool_error("Discord scoped send was denied")


def _issue_approval(
    *,
    job_id: str,
    destination: str,
    message: str,
    ttl_seconds: int = _DEFAULT_APPROVAL_TTL,
) -> dict[str, Any]:
    """Issue one digest-only approval from the operator CLI path."""
    if not isinstance(job_id, str) or not job_id.strip():
        raise ValueError("job id is required")
    destination = _snowflake(destination, "destination")
    if not isinstance(message, str) or not message.strip():
        raise ValueError("message is required")
    if len(message) > _MAX_MESSAGE_LENGTH:
        raise ValueError("message exceeds Discord's 2000 character limit")
    if isinstance(ttl_seconds, bool):
        raise ValueError("approval TTL is invalid")
    try:
        ttl = int(ttl_seconds)
    except (TypeError, ValueError) as exc:
        raise ValueError("approval TTL is invalid") from exc
    if not _MIN_APPROVAL_TTL <= ttl <= _MAX_APPROVAL_TTL:
        raise ValueError("approval TTL must be between 30 and 3600 seconds")

    from cron import jobs as cron_jobs

    job = cron_jobs.get_job(job_id)
    if not isinstance(job, dict) or str(job.get("id") or "") != job_id:
        raise ValueError("job is not present in the active profile")
    policy = _policy(job)
    expected_destination = policy["thread_id"] or policy["parent_channel_id"]
    if destination != expected_destination:
        raise ValueError("destination does not match the exact cron policy")

    issued_at = time.time()
    record = {
        "profile_digest": _digest("profile", policy["profile"]),
        "job_digest": _digest("job", job_id),
        "destination_digest": _digest("destination", destination),
        "message_sha256": _message_hash(message),
        # Keep only the digest of the random nonce.  The nonce is consumed by
        # the atomic used_at transition and is never printed or persisted.
        "nonce_digest": hashlib.sha256(secrets.token_bytes(32)).hexdigest(),
        "issued_at": issued_at,
        "expires_at": issued_at + ttl,
        "used_at": None,
    }
    with _approval_store_lock():
        records = _load_approvals()
        records.append(record)
        _save_approvals(records)
    return {"ok": True, "expires_in": ttl}


def register_cli(subparser: argparse.ArgumentParser) -> None:
    """Register the human-only ``hermes discord-scoped approve`` command."""
    subs = subparser.add_subparsers(dest="discord_scoped_command")
    approve = subs.add_parser(
        "approve",
        help="Issue one exact-target, one-use Discord send approval (human-only)",
    )
    approve.add_argument("--job-id", required=True)
    approve.add_argument("--destination", required=True)
    approve.add_argument("--message", required=True)
    approve.add_argument("--ttl-seconds", type=int, default=_DEFAULT_APPROVAL_TTL)
    subparser.set_defaults(func=cli_command)


def cli_command(args: argparse.Namespace) -> int:
    if getattr(args, "discord_scoped_command", None) != "approve":
        print("usage: hermes discord-scoped approve --job-id ID --destination ID --message TEXT")
        return 2
    # A model tool cannot mint an approval through this first-party path: the
    # command requires a real interactive terminal and an explicit phrase.
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        print("Discord approval issuance requires an interactive human terminal.")
        return 2
    try:
        confirmation = input("Type APPROVE to issue this one-shot send approval: ").strip()
    except (EOFError, KeyboardInterrupt):
        print("Discord approval was not issued.")
        return 2
    if confirmation != "APPROVE":
        print("Discord approval was not issued.")
        return 2
    try:
        result = _issue_approval(
            job_id=str(args.job_id),
            destination=str(args.destination),
            message=str(args.message),
            ttl_seconds=args.ttl_seconds,
        )
    except (TypeError, ValueError):
        print("Discord approval could not be issued for the active exact-target job.")
        return 2
    print(f"Discord approval issued for the active exact-target job; expires in {result['expires_in']} seconds.")
    return 0


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
    ctx.register_tool(
        name="discord_scoped_send_approved",
        toolset="discord_scoped",
        schema=SEND_APPROVED_SCHEMA,
        handler=_send_approved,
        check_fn=_check_discord_scoped_available,
        requires_env=["DISCORD_BOT_TOKEN"],
        description=SEND_APPROVED_SCHEMA["description"],
        emoji="✅",
    )
