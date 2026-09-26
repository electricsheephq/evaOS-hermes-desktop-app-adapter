"""State DB rollback across the r34 pair: r33.6 <-> the tree under test, both directions.

Kept from the retired r31 suite (tests/r31_compat, r30.7 predecessor) and re-pointed at the r34
predecessor. The per-box rollback restores the pre-flip state.db copy, but a profile created after the
rung has no such copy and a missed restore leaves r33.6 on a file r34 opened; both directions must hold.
Each step runs in its own interpreter against a temporary database holding synthetic rows only.
Upstream FTS storage v3 (hermes_state_common.FTS_STORAGE_VERSION) re-points a settled external word
index at the ``messages_fts_src`` view and stamps ``3``; r33.6 stamps ``2`` and must still read,
append and search that layout, and every row either side wrote must stay searchable by the other.
"""

from __future__ import annotations

from pathlib import Path
import sqlite3
from typing import Any

import pytest

from tests.r34_compat import _pair as pair

_STATE_SCRIPT = r'''
import json, os
from pathlib import Path

DB, MODE, SESSION = Path(os.environ["R34_DB"]), os.environ["R34_MODE"], "r34-compat-session"
MARKERS = {
    "old": ("r33 old seed r33-old-anchor", "r33 old reply r33-old-reply"),
    "new": ("r34 new append r34-new-anchor",),
    "newseed": ("r34 new seed r34-seed-anchor", "r34 new seed reply r34-seed-reply"),
    "oldappend": ("r33 old append r33-old-append-anchor",),
    "oldnew": ("r33 old append to new r33-old-on-new-anchor",),
}

def _open():
    from hermes_state import SessionDB
    return SessionDB(db_path=DB)

def _check(db, *groups):
    texts = [row.get("content") for row in db.get_messages(SESSION)]
    for marker in sum((MARKERS[group] for group in groups), ()):
        assert marker in texts, marker
        assert any(row.get("session_id") == SESSION for row in db.search_messages(marker.split()[-1])), marker

def _with_db(groups=(), append=None, create=False):
    db = _open()
    try:
        if create:
            db.create_session(SESSION, source="cli")
        if groups:
            _check(db, *groups)
        if append:
            db.append_message(SESSION, append[0], append[1])
    finally:
        db.close()

def main():
    if MODE == "old_seed":
        _with_db(create=True, append=("user", MARKERS["old"][0]))
        _with_db(append=("assistant", MARKERS["old"][1]))
        _with_db(groups=("old",))
    elif MODE == "new_read_write":
        _with_db(groups=("old",), append=("assistant", MARKERS["new"][0]))
        _with_db(groups=("old", "new"))
    elif MODE == "new_restart_check":
        _with_db(groups=("old", "new"))
    elif MODE == "old_read_append":
        _with_db(groups=("old", "new"), append=("user", MARKERS["oldappend"][0]))
        _with_db(groups=("old", "new", "oldappend"))
    elif MODE == "new_after_rollback":
        _with_db(groups=("old", "new", "oldappend"))
    elif MODE == "new_seed":
        _with_db(create=True, append=("user", MARKERS["newseed"][0]))
        _with_db(append=("assistant", MARKERS["newseed"][1]))
        _with_db(groups=("newseed",))
    elif MODE == "old_read_new_db":
        _with_db(groups=("newseed",), append=("assistant", MARKERS["oldnew"][0]))
        _with_db(groups=("newseed", "oldnew"))
    elif MODE == "new_final":
        _with_db(groups=("newseed", "oldnew"))
    else:
        raise ValueError(MODE)
    return {"status": "ok", "stage": MODE}

try:
    print(json.dumps(main(), sort_keys=True))
except Exception as exc:
    print(json.dumps({"status": "error", "stage": MODE, "error_type": type(exc).__name__}, sort_keys=True))
    raise SystemExit(3)
'''


def _snapshot(db_path: Path) -> dict[str, Any]:
    with sqlite3.connect(db_path) as conn:
        objects = tuple(conn.execute(
            "SELECT type, name, COALESCE(sql, '') FROM sqlite_master "
            "WHERE name LIKE 'messages_fts%' OR name LIKE 'fts_v22_trash_%' ORDER BY type, name"
        ).fetchall())
        schema_version = conn.execute("SELECT version FROM schema_version LIMIT 1").fetchone()[0]
        meta = dict(conn.execute("SELECT key, value FROM state_meta").fetchall())
        message_count = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        columns = tuple(
            conn.execute('SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid',
                         (table,)).fetchall()
            for table in ("sessions", "messages", "state_meta")
        )
    return {"objects": objects, "schema_version": schema_version, "meta": meta,
            "message_count": message_count, "columns": columns}


def _sql(snapshot: dict[str, Any]) -> dict[str, str]:
    return {name: sql.lower().replace(" ", "") for _kind, name, sql in snapshot["objects"]}


def _layout(snapshot: dict[str, Any]) -> tuple[str | None, str | None]:
    """(fts_storage_version stamp, word-index content source)."""
    word = _sql(snapshot)["messages_fts"]
    source = next((s for s in ("messages_fts_src", "messages") if f"content='{s}'" in word), None)
    return snapshot["meta"].get("fts_storage_version"), source


def _assert_external_layout(snapshot: dict[str, Any]) -> None:
    sql = _sql(snapshot)
    assert snapshot["meta"].get("fts_storage_version") in ("2", "3")
    assert "messages_fts_trigram_src" in sql
    assert "content='messages_fts_trigram_src'" in sql["messages_fts_trigram"]
    assert any(source in sql["messages_fts"] for source in ("content='messages'", "content='messages_fts_src'"))
    assert "fts_rebuild_high_water" not in snapshot["meta"]
    assert "fts_rebuild_progress" not in snapshot["meta"]
    assert not any(name.startswith("fts_v22_trash_") for name in sql)


def test_state_round_trip_predecessor_target_predecessor(tmp_path: Path, request: pytest.FixtureRequest) -> None:
    """A database born on r33.6, used by r34, then rolled back to r33.6 and forward again."""
    old_root = pair.predecessor_root(request.config)
    new_root = pair.target_root(request.config)
    db = tmp_path / "predecessor-created.db"

    def run(root: Path, mode: str) -> None:
        pair.run_child(root, _STATE_SCRIPT, home=tmp_path / f"{mode}-home", R34_DB=str(db), R34_MODE=mode)

    run(old_root, "old_seed")
    born = _snapshot(db)
    _assert_external_layout(born)
    assert _layout(born) == ("2", "messages")

    run(new_root, "new_read_write")
    upgraded = _snapshot(db)
    assert upgraded["schema_version"] >= born["schema_version"]
    assert upgraded["message_count"] == born["message_count"] + 1
    assert {name for _k, name, _s in upgraded["objects"]} >= {name for _k, name, _s in born["objects"]}
    _assert_external_layout(upgraded)
    assert _layout(upgraded) == ("3", "messages_fts_src")

    run(new_root, "new_restart_check")
    restarted = _snapshot(db)
    assert restarted["objects"] == upgraded["objects"]
    assert restarted["columns"] == upgraded["columns"]
    assert restarted["message_count"] == upgraded["message_count"]

    run(old_root, "old_read_append")  # the rollback: r33.6 reads, searches and appends every row
    rolled_back = _snapshot(db)
    assert rolled_back["message_count"] == upgraded["message_count"] + 1
    _assert_external_layout(rolled_back)
    # r33.6 restamps its own marker over the v3 layout; the view-backed word index stays in place.
    assert _layout(rolled_back) == ("2", "messages_fts_src")

    run(new_root, "new_after_rollback")  # and the re-rung reads what r33.6 appended
    after = _snapshot(db)
    _assert_external_layout(after)
    assert _layout(after) == ("3", "messages_fts_src")


def test_state_target_created_database_reads_back_on_predecessor(
    tmp_path: Path, request: pytest.FixtureRequest
) -> None:
    """A database first created by r34 (a profile born after the rung) survives a rollback to r33.6."""
    old_root = pair.predecessor_root(request.config)
    new_root = pair.target_root(request.config)
    db = tmp_path / "target-created.db"

    def run(root: Path, mode: str) -> None:
        pair.run_child(root, _STATE_SCRIPT, home=tmp_path / f"{mode}-home", R34_DB=str(db), R34_MODE=mode)

    run(new_root, "new_seed")
    born = _snapshot(db)
    _assert_external_layout(born)
    assert _layout(born) == ("3", "messages_fts_src")

    run(old_root, "old_read_new_db")
    rolled_back = _snapshot(db)
    assert rolled_back["message_count"] == born["message_count"] + 1
    assert _sql(rolled_back)["messages_fts_trigram"] == _sql(born)["messages_fts_trigram"]
    _assert_external_layout(rolled_back)

    run(new_root, "new_final")
