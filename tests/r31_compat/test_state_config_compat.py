"""Synthetic r30.7 <-> current state/config compatibility probes.

These tests deliberately run the immutable r30.7 checkout and the checkout under
test in separate Python processes.  The database is temporary and contains only
synthetic rows; no live Hermes home is consulted.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
from typing import Any

import pytest

CURRENT_ROOT = Path(__file__).resolve().parents[2]
OLD_ROOT = CURRENT_ROOT.parent / "evaos-r31-r307-baseline"
OLD_HEAD = "d02f246755153b318d472e30abb960f8578f8cfa"


_STATE_SCRIPT = r'''
import json, os
from pathlib import Path

DB, MODE, SESSION = Path(os.environ["R31_DB"]), os.environ["R31_MODE"], "r31-compat-session"
MARKERS = {
    "old": ("r30 old seed r30-old-anchor", "r30 old reply r30-old-reply"),
    "new": ("r31 new append r31-new-anchor",),
    "newseed": ("r31 new seed r31-seed-anchor", "r31 new seed reply r31-seed-reply"),
    "oldappend": ("r30 old append r30-old-append-anchor",),
    "oldnew": ("r30 old append to new r30-old-on-new-anchor",),
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


_CONFIG_SCRIPT = r'''
import json
import os
from pathlib import Path

HOME = Path(os.environ["HERMES_HOME"])
MODE = os.environ["R31_CONFIG_MODE"]
CASE, PHASE = MODE.split(":", 1)
MANAGED_DIR = os.environ.get("R31_MANAGED_DIR")
if MANAGED_DIR:
    os.environ["HERMES_MANAGED_DIR"] = MANAGED_DIR

CONFIG_TEXT = {
    "managed_default": "_config_version: 39\nmodel_catalog:\n  ttl_hours: 1\n",
    "managed_scope": "_config_version: 39\nmodel_catalog:\n  ttl_hours: 1\n",
    "explicit_hours": "_config_version: 39\nmodel_catalog:\n  ttl_hours: 7\n",
    "explicit_minutes": (
        "_config_version: 39\nmodel_catalog:\n  ttl_hours: 1\n  ttl_minutes: 90\n"
    ),
}[CASE]
def _catalog():
    from hermes_cli.model_catalog import _load_catalog_config
    return _load_catalog_config()
def main():
    HOME.mkdir(parents=True, exist_ok=True)
    path = HOME / "config.yaml"
    if PHASE == "seed":
        path.write_text(CONFIG_TEXT, encoding="utf-8")
        from hermes_cli.config import load_config
        merged = load_config()
        return {
            "status": "ok",
            "phase": PHASE,
            "case": CASE,
            "version": merged.get("_config_version"),
            "ttl_hours": _catalog()["ttl_hours"],
        }

    from hermes_cli.config import migrate_config, read_raw_config
    migrate_config(interactive=False, quiet=True)
    raw = read_raw_config()
    model_catalog = raw.get("model_catalog")
    if not isinstance(model_catalog, dict):
        model_catalog = {}
    return {
        "status": "ok",
        "phase": PHASE,
        "case": CASE,
        "version": raw.get("_config_version"),
        "ttl_hours_raw": model_catalog.get("ttl_hours"),
        "ttl_minutes_raw": model_catalog.get("ttl_minutes"),
        "ttl_hours": _catalog()["ttl_hours"],
    }
try:
    print(json.dumps(main(), sort_keys=True))
except Exception as exc:
    print(json.dumps({
        "status": "error",
        "phase": PHASE,
        "case": CASE,
        "error_type": type(exc).__name__,
    }, sort_keys=True))
    raise SystemExit(3)
'''


def _run_child(root: Path, script: str, *, home: Path, **variables: str) -> dict[str, Any]:
    env = os.environ.copy()
    env["HERMES_HOME"] = str(home)
    env["HOME"] = str(home / "operator-home")
    env["XDG_CONFIG_HOME"] = str(home / "xdg-config")
    env["PYTHONPATH"] = str(root)
    env["PYTHONNOUSERSITE"] = "1"
    for key in tuple(env):
        if key.startswith("HERMES_") and key != "HERMES_HOME":
            env.pop(key, None)
    for key, value in variables.items():
        env[key] = value
    completed = subprocess.run(
        [sys.executable, "-c", script],
        cwd=root,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    payload = None
    for line in reversed(completed.stdout.splitlines()):
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict):
            payload = candidate
            break
    if completed.returncode != 0 or payload is None or payload.get("status") != "ok":
        detail = payload or {"status": "no-payload"}
        pytest.fail(
            f"compat subprocess failed root={root.name} variables={variables} "
            f"returncode={completed.returncode} stage={detail.get('stage', detail.get('phase'))} "
            f"error_type={detail.get('error_type', 'unknown')}"
        )
    return payload
def _checkout_head(root: Path) -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    )
    return completed.stdout.strip()
def _snapshot(db_path: Path) -> dict[str, Any]:
    with sqlite3.connect(db_path) as conn:
        objects = tuple(
            conn.execute(
                "SELECT type, name, COALESCE(sql, '') FROM sqlite_master "
                "WHERE name LIKE 'messages_fts%' OR name LIKE 'fts_v22_trash_%' "
                "ORDER BY type, name"
            ).fetchall()
        )
        schema_version = conn.execute("SELECT version FROM schema_version LIMIT 1").fetchone()[0]
        meta = dict(conn.execute("SELECT key, value FROM state_meta").fetchall())
        message_count = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        columns = tuple(
            conn.execute(
                'SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid',
                (table,),
            ).fetchall()
            for table in ("sessions", "messages", "state_meta")
        )
    return {
        "objects": objects,
        "schema_version": schema_version,
        "meta": meta,
        "message_count": message_count,
        "columns": columns,
    }
def _object_map(snapshot: dict[str, Any]) -> dict[str, str]:
    return {name: sql for _kind, name, sql in snapshot["objects"]}


def _assert_external_v1(snapshot: dict[str, Any]) -> None:
    names = {name for _kind, name, _sql in snapshot["objects"]}
    sql = _object_map(snapshot)
    assert snapshot["meta"].get("fts_storage_version") in (None, "1")
    assert "messages_fts_trigram_src" in names
    assert "fts_rebuild_high_water" not in snapshot["meta"]
    assert "fts_rebuild_progress" not in snapshot["meta"]
    assert not any(name.startswith("fts_v22_trash_") for name in names)
    assert "content='messages'" in sql["messages_fts"].lower().replace(" ", "")
    assert "content='messages_fts_trigram_src'" in sql["messages_fts_trigram"].lower().replace(" ", "")
    assert "tool_calls" in sql["messages_fts_trigram"].lower()
def _assert_external_v2(snapshot: dict[str, Any]) -> None:
    names = {name for _kind, name, _sql in snapshot["objects"]}
    sql = _object_map(snapshot)
    # The old runtime stamps its own marker after a compatible append.  The
    # physical v2 layout is the compatibility invariant; the marker is not.
    assert snapshot["meta"].get("fts_storage_version") in (None, "1", "2")
    assert "messages_fts_trigram_src" in names
    assert "content='messages'" in sql["messages_fts"].lower().replace(" ", "")
    assert "content='messages_fts_trigram_src'" in sql["messages_fts_trigram"].lower().replace(" ", "")
    assert "tool_calls" not in sql["messages_fts_trigram"].lower()
def test_state_round_trip_old_new_old_and_candidate_readback(tmp_path: Path) -> None:
    """Exercise both persistent directions, including restart boundaries."""
    assert OLD_ROOT.is_dir(), f"required immutable predecessor is missing: {OLD_ROOT}"
    assert _checkout_head(OLD_ROOT) == OLD_HEAD

    old_db = tmp_path / "old-created.db"
    _run_child(OLD_ROOT, _STATE_SCRIPT, home=tmp_path / "old-home", R31_DB=str(old_db), R31_MODE="old_seed")
    old_before = _snapshot(old_db)
    assert old_before["schema_version"] == 26
    _assert_external_v1(old_before)

    _run_child(
        CURRENT_ROOT,
        _STATE_SCRIPT,
        home=tmp_path / "new-home",
        R31_DB=str(old_db),
        R31_MODE="new_read_write",
    )
    old_after = _snapshot(old_db)
    assert old_after["schema_version"] == 30
    assert old_after["message_count"] == old_before["message_count"] + 1
    assert set(name for _kind, name, _sql in old_after["objects"]) >= {
        name for _kind, name, _sql in old_before["objects"]
    }
    _assert_external_v1(old_after)

    _run_child(
        CURRENT_ROOT,
        _STATE_SCRIPT,
        home=tmp_path / "new-restart-home",
        R31_DB=str(old_db),
        R31_MODE="new_restart_check",
    )
    old_stable = _snapshot(old_db)
    assert old_stable["objects"] == old_after["objects"]
    assert old_stable["columns"] == old_after["columns"]
    assert old_stable["message_count"] == old_after["message_count"]
    _assert_external_v1(old_stable)

    _run_child(
        OLD_ROOT,
        _STATE_SCRIPT,
        home=tmp_path / "old-append-home",
        R31_DB=str(old_db),
        R31_MODE="old_read_append",
    )

    candidate_db = tmp_path / "new-created.db"
    _run_child(
        CURRENT_ROOT,
        _STATE_SCRIPT,
        home=tmp_path / "new-seed-home",
        R31_DB=str(candidate_db),
        R31_MODE="new_seed",
    )
    candidate_before = _snapshot(candidate_db)
    assert candidate_before["schema_version"] == 30
    _assert_external_v2(candidate_before)

    _run_child(
        OLD_ROOT,
        _STATE_SCRIPT,
        home=tmp_path / "old-read-new-home",
        R31_DB=str(candidate_db),
        R31_MODE="old_read_new_db",
    )
    candidate_after = _snapshot(candidate_db)
    assert candidate_after["message_count"] == candidate_before["message_count"] + 1
    assert _object_map(candidate_after)["messages_fts"] == _object_map(candidate_before)["messages_fts"]
    assert _object_map(candidate_after)["messages_fts_trigram"] == _object_map(candidate_before)["messages_fts_trigram"]
    _assert_external_v2(candidate_after)

    _run_child(
        CURRENT_ROOT,
        _STATE_SCRIPT,
        home=tmp_path / "new-final-home",
        R31_DB=str(candidate_db),
        R31_MODE="new_final",
    )
@pytest.mark.parametrize("case", ["managed_default", "explicit_hours", "explicit_minutes"])
def test_config39_to40_ttl_boundary_preserves_unmanaged_values(tmp_path: Path, case: str) -> None:
    """Migrate a real v39 file written/read by r30.7, then verify v40 semantics."""
    assert OLD_ROOT.is_dir(), f"required immutable predecessor is missing: {OLD_ROOT}"
    assert _checkout_head(OLD_ROOT) == OLD_HEAD
    home = tmp_path / case
    seeded = _run_child(
        OLD_ROOT,
        _CONFIG_SCRIPT,
        home=home,
        R31_CONFIG_MODE=f"{case}:seed",
    )
    expected_seed_ttl = {"managed_default": 1.0, "explicit_hours": 7.0, "explicit_minutes": 1.0}[case]
    assert seeded["version"] == 39
    assert seeded["ttl_hours"] == expected_seed_ttl

    migrated = _run_child(
        CURRENT_ROOT,
        _CONFIG_SCRIPT,
        home=home,
        R31_CONFIG_MODE=f"{case}:migrate",
    )
    assert migrated["version"] == 40
    if case == "managed_default":
        assert migrated["ttl_hours_raw"] is None
        assert migrated["ttl_hours"] == pytest.approx(1 / 3)
    elif case == "explicit_hours":
        assert migrated["ttl_hours_raw"] == 7
        assert migrated["ttl_hours"] == pytest.approx(7.0)
    else:
        assert migrated["ttl_hours_raw"] == 1
        assert migrated["ttl_minutes_raw"] == 90
        assert migrated["ttl_hours"] == pytest.approx(1.5)


def test_managed_scope_preserves_ttl_policy_for_profile(tmp_path: Path) -> None:
    """A documented managed-scope policy must survive a profile migration."""
    managed = tmp_path / "managed-scope"
    managed.mkdir()
    (managed / "config.yaml").write_text(
        "model_catalog:\n  ttl_hours: 1\n", encoding="utf-8"
    )
    home = tmp_path / "managed-profile"
    seeded = _run_child(
        OLD_ROOT,
        _CONFIG_SCRIPT,
        home=home,
        R31_CONFIG_MODE="managed_scope:seed",
        R31_MANAGED_DIR=str(managed),
    )
    assert seeded["version"] == 39
    assert seeded["ttl_hours"] == pytest.approx(1.0)
    prior_config = (home / "config.yaml").read_bytes()

    migrated = _run_child(
        CURRENT_ROOT,
        _CONFIG_SCRIPT,
        home=home,
        R31_CONFIG_MODE="managed_scope:migrate",
        R31_MANAGED_DIR=str(managed),
    )
    # New code interprets v39 in memory: do not stamp a migration which the
    # managed update deliberately did not perform, or rewrite existing keys.
    assert migrated["version"] == 39
    assert (home / "config.yaml").read_bytes() == prior_config
    assert migrated["ttl_hours_raw"] == 1
    assert migrated["ttl_hours"] == pytest.approx(1.0)
    assert (managed / "config.yaml").read_text(encoding="utf-8") == (
        "model_catalog:\n  ttl_hours: 1\n"
    )

def test_managed_migrate_config_validates_then_preserves_disk(monkeypatch, tmp_path):
    from hermes_cli import config, managed_scope

    managed_dir = tmp_path / "managed"
    managed_dir.mkdir()
    monkeypatch.setenv("HERMES_MANAGED_DIR", str(managed_dir))
    managed_scope.invalidate_managed_cache()

    monkeypatch.setattr(config, "check_config_version", lambda **_: (39, 40))
    monkeypatch.setattr(
        config,
        "sanitize_env_file",
        lambda: (_ for _ in ()).throw(AssertionError("managed migration mutated dotenv")),
    )

    result = config.migrate_config(interactive=False, quiet=True)

    assert result == {"env_added": [], "config_added": [], "warnings": []}


def test_managed_authority_keys_are_write_denied_before_scope_lookup(monkeypatch):
    from hermes_cli import config, managed_scope

    monkeypatch.setattr(managed_scope, "get_managed_dir", lambda: (_ for _ in ()).throw(
        AssertionError("protected key consulted managed scope")
    ))
    for key in ("HERMES_MANAGED_DIR", "HERMES_SHARED_AUTH_FILE", "CREDENTIALS_DIRECTORY"):
        try:
            config.validate_env_var_name_for_write(key)
        except ValueError as exc:
            assert "denylist" in str(exc)
        else:
            raise AssertionError(f"{key} was accepted by the writer denylist")
