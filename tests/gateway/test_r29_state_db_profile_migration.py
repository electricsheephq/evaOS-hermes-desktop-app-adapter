"""Synthetic, content-free coverage for the r29 R1 state-db migration.

The fixture uses the real ``SessionDB`` schema, but only opaque synthetic ids
and short marker strings.  No customer database or transcript is read here;
the protected cloned-box rehearsal remains an operator/root gate.
"""

from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

import pytest


SCRIPT = Path(__file__).parents[2] / "scripts" / "migrate-state-db-profiles.py"
SPEC = importlib.util.spec_from_file_location("r29_state_db_migration", SCRIPT)
assert SPEC and SPEC.loader
migration = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = migration
SPEC.loader.exec_module(migration)


def _make_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, multiplex: bool = True) -> Path:
    home = tmp_path / "hermes"
    (home / "profiles" / "fitness").mkdir(parents=True)
    (home / "config.yaml").write_text(
        "gateway:\n  multiplex_profiles: " + ("true" if multiplex else "false") + "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.delenv("GATEWAY_MULTIPLEX_PROFILES", raising=False)
    return home


def _seed_root(home: Path) -> tuple[str, str]:
    """Create one synthetic profile session and its dependent rows."""
    from hermes_state import SessionDB

    session_id = "synthetic-fitness-session"
    prompt_hash = "synthetic-prompt-hash"
    db = SessionDB(db_path=home / "state.db")
    conn = db._conn
    conn.execute("BEGIN IMMEDIATE")
    conn.execute(
        "INSERT INTO system_prompts(hash, prompt) VALUES (?, ?)",
        (prompt_hash, "synthetic prompt"),
    )
    conn.execute(
        """
        INSERT INTO sessions(id, source, started_at, profile_name,
                             system_prompt_hash, message_count)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (session_id, "synthetic", 1.0, "fitness", prompt_hash, 1),
    )
    conn.execute(
        """
        INSERT INTO messages(session_id, role, content, timestamp)
        VALUES (?, ?, ?, ?)
        """,
        (session_id, "user", "synthetic message", 2.0),
    )
    conn.execute(
        """
        INSERT INTO session_model_usage(session_id, model, api_call_count)
        VALUES (?, ?, ?)
        """,
        (session_id, "synthetic-model", 1),
    )
    conn.execute(
        """
        INSERT INTO gateway_routing(scope, session_key, entry_json, updated_at)
        VALUES (?, ?, ?, ?)
        """,
        (
            "synthetic-root-scope",
            "agent:fitness:synthetic:dm:opaque",
            json.dumps({"session_id": session_id, "session_key": "opaque"}),
            3.0,
        ),
    )
    conn.commit()
    db.close()
    return session_id, prompt_hash


def _read_destination(path: Path, session_id: str) -> None:
    conn = sqlite3.connect(path)
    try:
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        assert conn.execute("SELECT id FROM sessions WHERE id = ?", (session_id,)).fetchone()
        assert conn.execute("SELECT session_id FROM messages WHERE session_id = ?", (session_id,)).fetchone()
    finally:
        conn.close()


def test_copy_parity_fk_and_resume_regression(tmp_path, monkeypatch):
    home = _make_home(tmp_path, monkeypatch)
    session_id, _prompt_hash = _seed_root(home)

    result = migration.run_migration(home)

    assert result["status"] == "PASS"
    profile = result["profiles"]["fitness"]
    assert profile["parity"] is True
    assert profile["foreign_key_check"] == {"errors": 0, "pass": True}
    assert all(profile["tables"][table]["match"] for table in migration.PARITY_TABLES)
    assert profile["new_rows"] > 0
    destination = home / "profiles" / "fitness" / "state.db"
    _read_destination(destination, session_id)

    # This is the post-cutover resume seam: the real SessionDB reader sees the
    # pre-cutover session and transcript in the profile-local store.
    from hermes_state import SessionDB

    db = SessionDB(db_path=destination)
    try:
        assert db.get_session(session_id)["id"] == session_id
        assert db.get_messages(session_id)[0]["session_id"] == session_id
    finally:
        db.close()


def test_second_run_is_idempotent_and_hash_stable(tmp_path, monkeypatch):
    home = _make_home(tmp_path, monkeypatch)
    _seed_root(home)

    first = migration.run_migration(home)
    second = migration.run_migration(home)

    first_profile = first["profiles"]["fitness"]
    second_profile = second["profiles"]["fitness"]
    assert first_profile["parity"] is True
    assert second_profile["parity"] is True
    assert second_profile["new_rows"] == 0
    for table in migration.TABLES:
        assert (
            first_profile.get("tables", {}).get(table, first_profile["auxiliary_tables"].get(table, {})).get(
                "source_sha256"
            )
            == second_profile.get("tables", {}).get(table, second_profile["auxiliary_tables"].get(table, {})).get(
                "source_sha256"
            )
        )


def test_dry_run_reads_and_compares_without_creating_destination(tmp_path, monkeypatch):
    home = _make_home(tmp_path, monkeypatch)
    _seed_root(home)
    evidence_path = tmp_path / "evidence" / "dry-run.json"

    result = migration.run_migration(home, dry_run=True)

    assert result["status"] == "DRY_RUN"
    assert result["profiles"]["fitness"]["dry_run"] is True
    assert not (home / "profiles" / "fitness" / "state.db").exists()
    assert not evidence_path.exists()


def test_per_profile_unit_topology_is_machine_readable_skip(tmp_path, monkeypatch):
    home = _make_home(tmp_path, monkeypatch, multiplex=False)
    evidence_path = tmp_path / "evidence" / "skip.json"

    result = migration.run_migration(home, topology="auto")

    assert result["status"] == "SKIP"
    assert result["topology"] == "per-profile-unit"
    assert not (home / "profiles" / "fitness" / "state.db").exists()
    migration._write_evidence(evidence_path, result)
    assert json.loads(evidence_path.read_text(encoding="utf-8"))["status"] == "SKIP"


def test_non_multiplexed_single_home_refuses_to_run(tmp_path, monkeypatch):
    home = tmp_path / "single"
    home.mkdir()
    (home / "config.yaml").write_text("gateway:\n  multiplex_profiles: false\n", encoding="utf-8")
    monkeypatch.delenv("GATEWAY_MULTIPLEX_PROFILES", raising=False)

    with pytest.raises(migration.MigrationError, match="not multiplexed"):
        migration.run_migration(home)


def test_injected_destination_mismatch_returns_nonzero(tmp_path, monkeypatch):
    home = _make_home(tmp_path, monkeypatch)
    _seed_root(home)
    migration.run_migration(home)

    destination = home / "profiles" / "fitness" / "state.db"
    conn = sqlite3.connect(destination)
    try:
        conn.execute(
            "UPDATE messages SET content = ? WHERE session_id = ?",
            ("injected mismatch", "synthetic-fitness-session"),
        )
        conn.commit()
    finally:
        conn.close()

    evidence_path = tmp_path / "evidence" / "mismatch.json"
    exit_code = migration.main(["--home", str(home), "--evidence", str(evidence_path)])
    assert exit_code != 0
    assert json.loads(evidence_path.read_text(encoding="utf-8"))["status"] == "FAIL"


def test_routing_scope_variance_fails_closed(tmp_path, monkeypatch):
    home = _make_home(tmp_path, monkeypatch)
    session_id, _ = _seed_root(home)
    from hermes_state import SessionDB

    db = SessionDB(db_path=home / "state.db")
    db._conn.execute(
        "INSERT INTO gateway_routing(scope, session_key, entry_json, updated_at) VALUES (?, ?, ?, ?)",
        (
            "different-scope",
            "agent:fitness:synthetic:dm:opaque-2",
            json.dumps({"session_id": session_id}),
            4.0,
        ),
    )
    db._conn.commit()
    db.close()

    with pytest.raises(migration.MigrationError, match="scope varies"):
        migration.run_migration(home)
