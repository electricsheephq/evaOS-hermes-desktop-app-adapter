#!/usr/bin/env python3
"""Copy pre-r29 multiplexed session rows into per-profile state databases.

This is deliberately a forward, copy-only migration.  The root database is
never opened writable and remains the rollback copy.  A destination is built
by opening :class:`hermes_state.SessionDB`, so schema creation and column
reconciliation stay owned by the real application schema.

The command is intended for a quiescent, fully multiplexed Hermes home::

    python scripts/migrate-state-db-profiles.py --home /path/to/hermes \
        --evidence /path/to/r29-R1-migration.json

``--dry-run`` reads and compares the source and any existing destinations but
does not create databases or write rows.  Evidence is written only when the
caller supplies ``--evidence``; it contains counts and hashes, never session
content.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import sqlite3
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence
from urllib.parse import quote


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

TABLES = ("sessions", "system_prompts", "messages", "session_model_usage", "gateway_routing")
PARITY_TABLES = ("sessions", "system_prompts", "messages", "gateway_routing")
KEY_COLUMNS = {
    "sessions": ("id",),
    "system_prompts": ("hash",),
    "messages": ("id",),
    "session_model_usage": (
        "session_id",
        "model",
        "billing_provider",
        "billing_base_url",
        "billing_mode",
        "task",
    ),
    "gateway_routing": ("scope", "session_key"),
}


class MigrationError(RuntimeError):
    """A fail-closed migration or verification error."""


class TopologySkip(MigrationError):
    """The home is a valid per-profile-unit topology; no migration is needed."""


Row = dict[str, Any]


@dataclass(frozen=True)
class Snapshot:
    """Rows and columns from one source or destination projection."""

    columns: tuple[str, ...]
    rows: tuple[Row, ...]


def _qident(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def _open_readonly(path: Path) -> sqlite3.Connection:
    """Open *path* read-only, without creating a missing file."""
    if not path.is_file():
        raise MigrationError(f"source or destination database is missing: {path}")
    uri = f"file:{quote(str(path.resolve()), safe='/')}?mode=ro"
    try:
        conn = sqlite3.connect(uri, uri=True)
    except sqlite3.Error as exc:
        raise MigrationError(f"could not open database read-only: {type(exc).__name__}") from exc
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _table_columns(conn: sqlite3.Connection, table: str) -> tuple[str, ...]:
    try:
        rows = conn.execute(f"PRAGMA table_info({_qident(table)})").fetchall()
    except sqlite3.Error as exc:
        raise MigrationError(f"could not inspect destination schema for {table}") from exc
    return tuple(str(row[1]) for row in rows)


def _fetch_rows(
    conn: sqlite3.Connection,
    table: str,
    *,
    where: str | None = None,
    params: Sequence[Any] = (),
    columns: Sequence[str] | None = None,
) -> Snapshot:
    available = _table_columns(conn, table)
    if not available:
        return Snapshot((), ())
    selected = tuple(columns or available)
    missing = [column for column in selected if column not in available]
    if missing:
        raise MigrationError(f"{table} schema is missing a required column")
    sql = "SELECT " + ", ".join(_qident(column) for column in selected)
    sql += f" FROM {_qident(table)}"
    if where:
        sql += f" WHERE {where}"
    try:
        raw_rows = conn.execute(sql, tuple(params)).fetchall()
    except sqlite3.Error as exc:
        raise MigrationError(f"could not read {table}") from exc
    return Snapshot(
        selected,
        tuple(
            {column: row[index] for index, column in enumerate(selected)}
            for row in raw_rows
        ),
    )


def _json_safe(value: Any) -> Any:
    if isinstance(value, bytes):
        return {"__bytes_sha256__": hashlib.sha256(value).hexdigest(), "length": len(value)}
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _row_sort_key(row: Mapping[str, Any], columns: Sequence[str]) -> tuple[str, ...]:
    return tuple(json.dumps(_json_safe(row.get(column)), sort_keys=True) for column in columns)


def _canonical_hash(snapshot: Snapshot) -> str:
    rows = [
        [_json_safe(row.get(column)) for column in snapshot.columns]
        for row in sorted(snapshot.rows, key=lambda row: _row_sort_key(row, snapshot.columns))
    ]
    payload = json.dumps(rows, ensure_ascii=True, separators=(",", ":"), sort_keys=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _key(row: Mapping[str, Any], table: str) -> tuple[Any, ...]:
    return tuple(row.get(column) for column in KEY_COLUMNS[table])


def _normalize_profile(value: Any) -> str:
    if value is None or str(value).strip() in {"", "default"}:
        return "default"
    return str(value)


def _routing_profile(session_key: Any) -> str | None:
    """Extract the multiplex profile namespace from a routing key."""
    if not isinstance(session_key, str):
        return None
    parts = session_key.split(":")
    if len(parts) < 2 or parts[0] != "agent":
        return None
    return "default" if parts[1] in {"", "main", "default"} else parts[1]


def _routing_session_id(row: Mapping[str, Any]) -> str | None:
    try:
        entry = json.loads(str(row.get("entry_json") or ""))
    except (TypeError, ValueError):
        return None
    if not isinstance(entry, dict):
        return None
    session_id = entry.get("session_id")
    return str(session_id) if session_id is not None else None


def _config_mapping(home: Path) -> dict[str, Any]:
    """Load only non-secret topology settings from the home configuration."""
    merged: dict[str, Any] = {}
    gateway_json = home / "gateway.json"
    if gateway_json.is_file():
        try:
            value = json.loads(gateway_json.read_text(encoding="utf-8"))
            if isinstance(value, dict):
                merged.update(value)
        except (OSError, ValueError):
            pass
    config_yaml = home / "config.yaml"
    if config_yaml.is_file():
        try:
            import yaml

            value = yaml.safe_load(config_yaml.read_text(encoding="utf-8")) or {}
            if isinstance(value, dict):
                merged.update(value)
        except (OSError, ValueError, ImportError):
            pass
    return merged


def detect_topology(home: Path, requested: str = "auto") -> str:
    """Return ``multiplex``, ``per-profile-unit`` or ``single``.

    A false multiplex flag with named profile homes is the per-profile-unit
    topology and is a successful no-op.  A home without named profiles is a
    single-profile deployment and is an error for this migration.
    """
    if requested not in {"auto", "multiplex", "per-profile-unit", "single"}:
        raise MigrationError("invalid topology selection")
    if requested != "auto":
        return requested

    config = _config_mapping(home)
    nested = config.get("gateway")
    if not isinstance(nested, dict):
        nested = {}
    multiplex = config.get("multiplex_profiles")
    if multiplex is None:
        multiplex = nested.get("multiplex_profiles")
    env_value = os.environ.get("GATEWAY_MULTIPLEX_PROFILES", "").strip().lower()
    if env_value in {"1", "true", "yes", "on"}:
        multiplex = True
    elif env_value in {"0", "false", "no", "off"}:
        multiplex = False
    if isinstance(multiplex, str):
        multiplex = multiplex.strip().lower() in {"1", "true", "yes", "on"}
    if bool(multiplex):
        return "multiplex"
    profiles_dir = home / "profiles"
    named_profiles = [
        path
        for path in profiles_dir.iterdir()
        if path.is_dir() and path.name not in {"default"} and not path.name.startswith(".")
    ] if profiles_dir.is_dir() else []
    return "per-profile-unit" if named_profiles else "single"


def _profile_dirs(home: Path, requested: Iterable[str] | None) -> dict[str, Path]:
    base = home / "profiles"
    if requested:
        names = list(dict.fromkeys(str(name) for name in requested))
    else:
        names = [
            path.name
            for path in sorted(base.iterdir())
            if path.is_dir() and path.name not in {"default"} and not path.name.startswith(".")
        ] if base.is_dir() else []
    result: dict[str, Path] = {}
    for name in names:
        if not name or name in {".", ".."} or Path(name).name != name:
            raise MigrationError("profile name is not a single safe path component")
        path = base / name
        if not path.is_dir():
            raise MigrationError("requested profile directory is missing")
        result[name] = path
    if not result:
        raise MigrationError("multiplexed home has no named profile destinations")
    return result


def _require_columns(snapshot: Snapshot, table: str) -> None:
    missing = [column for column in KEY_COLUMNS[table] if column not in snapshot.columns]
    if missing:
        raise MigrationError(f"{table} has no stable key in the source schema")


def _source_profile_snapshots(
    source: sqlite3.Connection,
    profile: str,
) -> dict[str, Snapshot]:
    sessions_all = _fetch_rows(source, "sessions")
    _require_columns(sessions_all, "sessions")
    if "profile_name" not in sessions_all.columns:
        raise MigrationError("sessions schema has no profile_name column")
    sessions = Snapshot(
        sessions_all.columns,
        tuple(row for row in sessions_all.rows if _normalize_profile(row.get("profile_name")) == profile),
    )
    session_ids = [row["id"] for row in sessions.rows]
    placeholders = ",".join("?" for _ in session_ids)

    prompt_hashes = [row.get("system_prompt_hash") for row in sessions.rows if row.get("system_prompt_hash")]
    prompts = _fetch_rows(
        source,
        "system_prompts",
        where=f"hash IN ({','.join('?' for _ in prompt_hashes)})" if prompt_hashes else "0",
        params=prompt_hashes,
    )
    _require_columns(prompts, "system_prompts") if prompts.columns else None
    prompt_by_hash = {row["hash"]: row for row in prompts.rows}
    if set(prompt_hashes) != set(prompt_by_hash):
        raise MigrationError("source session references a missing system prompt")

    messages = _fetch_rows(
        source,
        "messages",
        where=f"session_id IN ({placeholders})" if session_ids else "0",
        params=session_ids,
    )
    _require_columns(messages, "messages") if messages.columns else None
    usage = _fetch_rows(
        source,
        "session_model_usage",
        where=f"session_id IN ({placeholders})" if session_ids else "0",
        params=session_ids,
    )
    _require_columns(usage, "session_model_usage") if usage.columns else None

    routing_all = _fetch_rows(source, "gateway_routing")
    _require_columns(routing_all, "gateway_routing") if routing_all.columns else None
    routing = tuple(
        row for row in routing_all.rows if _routing_profile(row.get("session_key")) == profile
    )
    if routing:
        scopes = {str(row.get("scope") or "") for row in routing}
        if len(scopes) != 1:
            raise MigrationError("gateway_routing.scope varies within a profile")

    # Parent rows are required for FK-safe insertion.  A parent belonging to a
    # different profile cannot be silently copied into this profile's store.
    selected_ids = set(session_ids)
    for row in sessions.rows:
        parent = row.get("parent_session_id")
        if parent is not None and parent not in selected_ids:
            raise MigrationError("session parent crosses profile migration boundary")

    return {
        "sessions": sessions,
        "system_prompts": prompts,
        "messages": messages,
        "session_model_usage": usage,
        "gateway_routing": Snapshot(routing_all.columns, routing),
    }


def _destination_snapshots(
    destination: sqlite3.Connection,
    profile: str,
    source_snapshots: Mapping[str, Snapshot],
) -> dict[str, Snapshot]:
    sessions_all = _fetch_rows(destination, "sessions")
    sessions = Snapshot(
        sessions_all.columns,
        tuple(row for row in sessions_all.rows if _normalize_profile(row.get("profile_name")) == profile),
    ) if sessions_all.columns and "profile_name" in sessions_all.columns else Snapshot((), ())
    ids = [row.get("id") for row in source_snapshots["sessions"].rows]
    prompt_keys = [row.get("hash") for row in source_snapshots["system_prompts"].rows]
    route_keys = [(_row["scope"], _row["session_key"]) for _row in source_snapshots["gateway_routing"].rows]
    messages = _fetch_rows(
        destination,
        "messages",
        where=f"session_id IN ({','.join('?' for _ in ids)})" if ids else "0",
        params=ids,
        columns=source_snapshots["messages"].columns or None,
    )
    usage = _fetch_rows(
        destination,
        "session_model_usage",
        where=f"session_id IN ({','.join('?' for _ in ids)})" if ids else "0",
        params=ids,
        columns=source_snapshots["session_model_usage"].columns or None,
    )
    prompts = _fetch_rows(
        destination,
        "system_prompts",
        where=f"hash IN ({','.join('?' for _ in prompt_keys)})" if prompt_keys else "0",
        params=prompt_keys,
        columns=source_snapshots["system_prompts"].columns or None,
    )
    routing_all = _fetch_rows(destination, "gateway_routing", columns=source_snapshots["gateway_routing"].columns or None)
    route_key_set = set(route_keys)
    routing = Snapshot(
        routing_all.columns,
        tuple(row for row in routing_all.rows if _key(row, "gateway_routing") in route_key_set),
    )
    return {
        "sessions": sessions,
        "system_prompts": prompts,
        "messages": messages,
        "session_model_usage": usage,
        "gateway_routing": routing,
    }


def _rows_by_key(snapshot: Snapshot, table: str) -> dict[tuple[Any, ...], Row]:
    _require_columns(snapshot, table)
    return {_key(row, table): row for row in snapshot.rows}


def _insert_if_missing(conn: sqlite3.Connection, table: str, row: Mapping[str, Any]) -> bool:
    columns = _table_columns(conn, table)
    if not columns:
        raise MigrationError(f"destination schema has no {table} table")
    key_columns = KEY_COLUMNS[table]
    if any(column not in columns for column in key_columns):
        raise MigrationError(f"destination {table} has no stable key")
    key_where = " AND ".join(f"{_qident(column)} = ?" for column in key_columns)
    key_values = tuple(row.get(column) for column in key_columns)
    existing = conn.execute(
        f"SELECT * FROM {_qident(table)} WHERE {key_where}", key_values
    ).fetchone()
    if existing is not None:
        existing_row = {column: existing[index] for index, column in enumerate(columns)}
        for column in row:
            if existing_row.get(column) != row.get(column):
                raise MigrationError(f"destination {table} row conflicts with source")
        return False
    insert_columns = [column for column in row if column in columns]
    if not insert_columns:
        raise MigrationError(f"source {table} has no destination columns")
    sql = (
        f"INSERT INTO {_qident(table)} ("
        + ", ".join(_qident(column) for column in insert_columns)
        + ") VALUES ("
        + ", ".join("?" for _ in insert_columns)
        + ")"
    )
    try:
        conn.execute(sql, tuple(row[column] for column in insert_columns))
    except sqlite3.Error as exc:
        raise MigrationError(f"could not insert {table} row") from exc
    return True


def _ordered_sessions(rows: Snapshot) -> list[Row]:
    by_id = {row["id"]: row for row in rows.rows}
    ordered: list[Row] = []
    visiting: set[Any] = set()
    visited: set[Any] = set()

    def visit(session_id: Any) -> None:
        if session_id in visited:
            return
        if session_id in visiting:
            raise MigrationError("session parent graph contains a cycle")
        visiting.add(session_id)
        parent = by_id[session_id].get("parent_session_id")
        if parent is not None:
            visit(parent)
        visiting.remove(session_id)
        visited.add(session_id)
        ordered.append(by_id[session_id])

    for session_id in by_id:
        visit(session_id)
    return ordered


def _copy_profile(
    source_snapshots: Mapping[str, Snapshot],
    destination: sqlite3.Connection,
    profile: str,
) -> int:
    """Copy one profile, one session transaction at a time."""
    sessions = source_snapshots["sessions"]
    prompts = _rows_by_key(source_snapshots["system_prompts"], "system_prompts") if source_snapshots["system_prompts"].columns else {}
    messages = defaultdict(list)
    for row in source_snapshots["messages"].rows:
        messages[row.get("session_id")].append(row)
    usage = defaultdict(list)
    for row in source_snapshots["session_model_usage"].rows:
        usage[row.get("session_id")].append(row)
    routing = defaultdict(list)
    routing_orphans: list[Row] = []
    session_ids = {row.get("id") for row in sessions.rows}
    for row in source_snapshots["gateway_routing"].rows:
        session_id = _routing_session_id(row)
        if session_id in session_ids:
            routing[session_id].append(row)
        else:
            routing_orphans.append(row)

    inserted = 0
    for session in _ordered_sessions(sessions):
        session_id = session["id"]
        try:
            destination.execute("BEGIN IMMEDIATE")
            prompt_hash = session.get("system_prompt_hash")
            if prompt_hash:
                inserted += int(
                    _insert_if_missing(destination, "system_prompts", prompts[(prompt_hash,)])
                )
            inserted += int(_insert_if_missing(destination, "sessions", session))
            for row in messages[session_id]:
                inserted += int(_insert_if_missing(destination, "messages", row))
            for row in usage[session_id]:
                inserted += int(_insert_if_missing(destination, "session_model_usage", row))
            for row in routing[session_id]:
                inserted += int(_insert_if_missing(destination, "gateway_routing", row))
            destination.commit()
        except MigrationError:
            destination.rollback()
            raise
        except sqlite3.Error as exc:
            destination.rollback()
            raise MigrationError(f"transaction failed for profile {profile}") from exc

    if routing_orphans:
        try:
            destination.execute("BEGIN IMMEDIATE")
            for row in routing_orphans:
                inserted += int(_insert_if_missing(destination, "gateway_routing", row))
            destination.commit()
        except MigrationError:
            destination.rollback()
            raise
        except sqlite3.Error as exc:
            destination.rollback()
            raise MigrationError(f"routing transaction failed for profile {profile}") from exc
    return inserted


def _empty_destination_snapshot(source_snapshots: Mapping[str, Snapshot]) -> dict[str, Snapshot]:
    return {
        table: Snapshot(snapshot.columns, ()) for table, snapshot in source_snapshots.items()
    }


def _parity(source: Mapping[str, Snapshot], destination: Mapping[str, Snapshot]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for table in TABLES:
        src = source[table]
        dst = destination[table]
        src_hash = _canonical_hash(src)
        dst_hash = _canonical_hash(dst)
        result[table] = {
            "source_count": len(src.rows),
            "destination_count": len(dst.rows),
            "source_sha256": src_hash,
            "destination_sha256": dst_hash,
            "match": len(src.rows) == len(dst.rows) and src_hash == dst_hash,
        }
    return result


def _overall_hash(snapshots: Mapping[str, Snapshot]) -> str:
    """Hash the table projection hashes without exposing row content."""
    payload = {
        table: _canonical_hash(snapshots[table])
        for table in TABLES
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _foreign_key_errors(conn: sqlite3.Connection) -> list[tuple[Any, ...]]:
    try:
        return [tuple(row) for row in conn.execute("PRAGMA foreign_key_check").fetchall()]
    except sqlite3.Error as exc:
        raise MigrationError("could not run foreign_key_check") from exc


@contextlib.contextmanager
def _real_session_db(home: Path, path: Path) -> Iterator[sqlite3.Connection]:
    """Build a destination with the shipped SessionDB schema and yield conn."""
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from hermes_state import SessionDB

    token = set_hermes_home_override(str(home))
    db = None
    try:
        db = SessionDB(db_path=path)
        db._conn.execute("PRAGMA foreign_keys=ON")
        yield db._conn
    finally:
        if db is not None:
            db.close()
        reset_hermes_home_override(token)


def _compare_and_record(
    source_snapshots: Mapping[str, Snapshot],
    destination: sqlite3.Connection,
    profile: str,
    *,
    inserted: int,
) -> dict[str, Any]:
    destination_snapshots = _destination_snapshots(destination, profile, source_snapshots)
    parity = _parity(source_snapshots, destination_snapshots)
    fk_errors = _foreign_key_errors(destination)
    result = {
        "tables": {table: parity[table] for table in PARITY_TABLES},
        "auxiliary_tables": {"session_model_usage": parity["session_model_usage"]},
        "source_sha256": _overall_hash(source_snapshots),
        "destination_sha256": _overall_hash(destination_snapshots),
        "new_rows": inserted,
        "foreign_key_check": {"errors": len(fk_errors), "pass": not fk_errors},
        "parity": all(item["match"] for item in parity.values()) and not fk_errors,
    }
    if not result["parity"]:
        raise MigrationError("row parity, hash, or foreign-key verification failed")
    return result


def run_migration(
    home: Path,
    *,
    source_path: Path | None = None,
    profiles: Iterable[str] | None = None,
    dry_run: bool = False,
    topology: str = "auto",
) -> dict[str, Any]:
    """Run the bounded migration and return redacted machine-readable evidence."""
    home = Path(home).expanduser().resolve()
    source_path = Path(source_path or home / "state.db").expanduser().resolve()
    detected = detect_topology(home, topology)
    if detected == "per-profile-unit":
        return {
            "status": "SKIP",
            "topology": detected,
            "reason": "per-profile-unit topology has no shared root state.db to drain",
            "dry_run": dry_run,
            "profiles": {},
        }
    if detected != "multiplex":
        raise MigrationError("refusing migration: home is not multiplexed")
    profile_dirs = _profile_dirs(home, profiles)

    profile_results: dict[str, Any] = {}
    with _open_readonly(source_path) as source:
        source_by_profile: dict[str, dict[str, Snapshot]] = {}
        for profile, profile_dir in profile_dirs.items():
            source_snapshots = _source_profile_snapshots(source, profile)
            source_by_profile[profile] = source_snapshots
            # A multiplexed SessionStore uses one routing scope for the shared
            # root index.  Different scopes would make an unchanged routing
            # row land outside the destination store's lookup namespace, so
            # fail closed before opening any destination writable.
            profile_scopes = {
                str(row.get("scope") or "")
                for row in source_snapshots["gateway_routing"].rows
            }
            if profile_scopes:
                all_scopes = {
                    str(row.get("scope") or "")
                    for snapshots in source_by_profile.values()
                    for row in snapshots["gateway_routing"].rows
                }
                if len(all_scopes) > 1:
                    raise MigrationError("gateway_routing.scope varies per profile")
            profile_result: dict[str, Any] = {
                "destination": str(profile_dir / "state.db"),
                "dry_run": dry_run,
            }
            destination_path = profile_dir / "state.db"
            if dry_run:
                if destination_path.is_file():
                    with _open_readonly(destination_path) as destination:
                        profile_result["parity"] = _parity(
                            source_snapshots,
                            _destination_snapshots(destination, profile, source_snapshots),
                        )
                        profile_result["source_sha256"] = _overall_hash(source_snapshots)
                        profile_result["destination_sha256"] = _overall_hash(
                            _destination_snapshots(destination, profile, source_snapshots)
                        )
                        profile_result["would_copy_rows"] = sum(
                            len(snapshot.rows) for snapshot in source_snapshots.values()
                        )
                else:
                    profile_result["parity"] = _parity(
                        source_snapshots, _empty_destination_snapshot(source_snapshots)
                    )
                    profile_result["source_sha256"] = _overall_hash(source_snapshots)
                    profile_result["destination_sha256"] = _overall_hash(
                        _empty_destination_snapshot(source_snapshots)
                    )
                    profile_result["would_copy_rows"] = sum(
                        len(snapshot.rows) for snapshot in source_snapshots.values()
                    )
                profile_result["parity_match"] = all(
                    value["match"] for value in profile_result["parity"].values()
                )
            else:
                with _real_session_db(home, destination_path) as destination:
                    inserted = _copy_profile(source_snapshots, destination, profile)
                    profile_result.update(
                        _compare_and_record(
                            source_snapshots,
                            destination,
                            profile,
                            inserted=inserted,
                        )
                    )
            profile_results[profile] = profile_result
    return {
        "status": "DRY_RUN" if dry_run else "PASS",
        "topology": detected,
        "dry_run": dry_run,
        "source": str(source_path),
        "profiles": profile_results,
    }


def _write_evidence(path: Path, evidence: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(evidence, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("home_positional", nargs="?", type=Path, help="Hermes home (or use --home)")
    parser.add_argument("--home", dest="home_option", type=Path, help="Hermes home")
    parser.add_argument("--source", type=Path, help="root state.db (default: HOME/state.db)")
    parser.add_argument("--profile", action="append", dest="profiles", help="named profile (repeatable)")
    parser.add_argument("--evidence", type=Path, help="write redacted evidence JSON to this path")
    parser.add_argument(
        "--topology",
        choices=("auto", "multiplex", "per-profile-unit", "single"),
        default="auto",
        help="override topology detection for a controlled rehearsal or test",
    )
    parser.add_argument("--dry-run", action="store_true", help="read and compare without creating or writing DBs")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    home = args.home_option or args.home_positional
    if home is None:
        home = Path(os.environ.get("HERMES_HOME", "~/.hermes"))
    try:
        evidence = run_migration(
            home,
            source_path=args.source,
            profiles=args.profiles,
            dry_run=args.dry_run,
            topology=args.topology,
        )
        exit_code = 0
    except TopologySkip as exc:
        evidence = {"status": "SKIP", "reason": str(exc), "topology": "per-profile-unit"}
        exit_code = 0
    except (MigrationError, OSError, sqlite3.Error) as exc:
        evidence = {"status": "FAIL", "reason": str(exc)}
        exit_code = 1
    if args.evidence:
        try:
            _write_evidence(args.evidence, evidence)
        except OSError as exc:
            print(json.dumps({"status": "FAIL", "reason": "could not write evidence"}))
            return 1
    print(json.dumps(evidence, indent=2, sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
