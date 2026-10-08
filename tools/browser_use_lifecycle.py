"""Scope-owned browser-harness cleanup; shared defaults persist outside cron.

The CLI has its own interpreter, so ask it for its IPC paths instead of importing
the harness into Hermes or duplicating its runtime-directory rules.
"""
from contextlib import contextmanager
import json
import logging
from pathlib import Path
import threading
import time
import uuid

import psutil

logger = logging.getLogger(__name__)
_OWNER_ENV = "_HERMES_HARNESS_OWNER"
_owned = {}
_borrows = {}
_borrow_keys = {}
_retries = {}
_lock = threading.Lock()

# The leading, unexecuted admin call bypasses CLI bootstrap (run.py cloud_admin).
# Neither a probe nor cleanup may start a replacement daemon.
_CONTROL = '''stop_remote_daemon() if False else None
import json, os
from browser_harness import _ipc
name = os.environ.get("BU_NAME", "default")
path = _ipc.pid_path(name)
try:
    raw = json.loads(path.read_text(encoding="utf-8"))
    pid = raw.get("pid") if isinstance(raw, dict) else raw
except (OSError, ValueError):
    pid = None
if os.environ.get("_HERMES_HARNESS_STOP") == str(pid) and _ipc.identify(name, timeout=1) == pid:
    sock, token = _ipc.connect(name, timeout=2)
    try:
        current = json.loads(path.read_text(encoding="utf-8"))
        current_pid = current.get("pid") if isinstance(current, dict) else current
        if current_pid == pid:
            _ipc.request(sock, token, {"meta": "shutdown"})
    finally:
        sock.close()
print("hermes-harness:" + json.dumps({"pid": pid, "path": str(path)}))
'''


def _control(cmd, env, stop=None):
    from tools.browser_use_cli import _run_cli_killing_process_group
    result = _run_cli_killing_process_group(
        cmd, _CONTROL, {**env, "_HERMES_HARNESS_STOP": str(stop or "")}, 5,
    )
    for line in reversed(result.stdout.splitlines()):
        if line.startswith("hermes-harness:"):
            return json.loads(line.removeprefix("hermes-harness:"))
    raise RuntimeError("harness control returned no identity")


def _matches(process, marker, started=None, name="default"):
    process = psutil.Process(process.pid)  # fresh start time, not Process's cached value
    argv = process.cmdline()
    module = any(argv[i:i + 2] == ["-m", "browser_harness.daemon"] for i in range(len(argv) - 1))
    env = process.environ()
    return (module and env.get(_OWNER_ENV) == marker and env.get("BU_NAME", "default") == name
            and (started is None or process.create_time() == started))


@contextmanager
def owned_harness_call(cmd, env, task_id, session):
    """Track spawns and reuse without changing the daemon's original fingerprint."""
    from tools.browser_use_cli import _backend_cache_key, _served_profile_tag
    tag = _served_profile_tag()
    scope = _scope_key(task_id, tag)
    cache_key = _backend_cache_key(task_id, session)
    marker = uuid.uuid4().hex
    env[_OWNER_ENV] = marker
    try:
        yield
    finally:
        try:
            # Retain only IPC/location inputs, never profile credentials or CDP tokens.
            control_env = {k: v for k, v in env.items() if k in {
                "PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "LOCALAPPDATA", "APPDATA",
                "TEMP", "TMP", "BU_NAME", "BH_HOME", "BROWSER_HARNESS_HOME", "XDG_CONFIG_HOME",
                "BH_RUNTIME_DIR", "BH_RUNTIME_DIR_SHARED", "BH_TMP_DIR", "BH_TMP_DIR_SHARED",
                "ANONYMIZED_TELEMETRY",
            }}
            identity = _control(cmd, control_env)
            pid = identity["pid"]
            if type(pid) is int and pid > 1:
                process = psutil.Process(pid)
                started = process.create_time()
                name = env.get("BU_NAME", "default")
                daemon_marker = process.environ().get(_OWNER_ENV)
                if _matches(process, daemon_marker, started, name):
                    with _lock:
                        if daemon_marker == marker:
                            record = (process, started, marker, identity["path"], cmd, control_env,
                                      name, cache_key, tag)
                            _owned.setdefault(scope, {})[pid] = record
                        else:
                            fingerprint = (pid, started)
                            _borrows.setdefault(fingerprint, set()).add(scope)
                            _borrow_keys[fingerprint, scope] = cache_key
        except Exception as exc:
            logger.warning("Harness ownership capture failed (%s)", type(exc).__name__)


def _scope_key(task_id, tag):
    task_key = task_id or "default"
    return (task_key, tag) if tag else task_key


def _held(record):
    from tools import browser_tool
    with browser_tool._cleanup_lock:
        expiry = browser_tool._session_last_activity.get(record[7], 0)
        return expiry if expiry > time.time() else 0


def _retry(task_id, scope, expiry, cron):
    from agent.memory_provider import ctx_bound

    def run():
        with _lock:
            if _retries.get(scope) is not timer:
                return
            _retries.pop(scope)
        cleanup_harnesses({task_id}, cron=cron)

    with _lock:
        if scope in _retries:
            return
        timer = threading.Timer(min(max(expiry - time.time() + 5, 5), 3600), ctx_bound(run))
        timer.daemon = True
        _retries[scope] = timer
        try:
            timer.start()
        except Exception:
            _retries.pop(scope, None)
            raise


def _stop(record):
    process, started, marker, path, cmd, env, name, key, tag = record
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    pid = raw.get("pid") if isinstance(raw, dict) else raw
    if pid != process.pid or not _matches(process, marker, started, name):
        return
    try:
        _control(cmd, env, stop=pid)  # harness shutdown releases its own tab/cloud resources
    except Exception as exc:
        logger.warning("Harness IPC shutdown failed (%s)", type(exc).__name__)
    for action in (None, process.terminate, process.kill):
        if action:
            if not _matches(process, marker, started, name):
                return
            action()  # only the recorded PID, never a process group or descendants
        try:
            process.wait(timeout=2)
            return
        except psutil.TimeoutExpired:
            continue


def cleanup_harnesses(task_ids, *, cron=False):
    """Session-end hook. Default/shared daemons are reaped only for cron owners.

    Callers bind the owning profile before agent.close(); retries copy that
    context. A future activity timestamp holds only that record until a retry.
    Adoption transfers the original fingerprint, never permission to kill a
    daemon not started by this runtime. Non-cron default adopters keep it alive.
    """
    for task_id in task_ids:
        try:
            from tools.browser_use_cli import _served_profile_tag
            tag = _served_profile_tag()
            scope = _scope_key(task_id, tag)
            with _lock:
                for fingerprint, borrowers in list(_borrows.items()):
                    borrowers.discard(scope)
                    _borrow_keys.pop((fingerprint, scope), None)
                    if not borrowers:
                        _borrows.pop(fingerprint)
                records = list(_owned.get(scope, {}).values())
            latest_hold = 0
            for record in records:
                if record[8] != tag:
                    continue  # an unscoped teardown cannot acquire another profile's receipt
                expiry = _held(record)
                if expiry:
                    latest_hold = max(latest_hold, expiry)
                    continue
                try:
                    if not cron and record[6] == "default":
                        continue  # shared interactive defaults relinquish ownership without reaping
                    with _lock:
                        fingerprint = (record[0].pid, record[1])
                        borrowers = _borrows.get(fingerprint, set())
                        if borrowers:
                            borrower = next(iter(borrowers))
                            borrower_tag = borrower[1] if isinstance(borrower, tuple) else ""
                            adopted = (*record[:7], _borrow_keys[fingerprint, borrower], borrower_tag)
                            _owned.setdefault(borrower, {})[record[0].pid] = adopted
                        else:
                            _stop(record)
                except (psutil.NoSuchProcess, FileNotFoundError):
                    pass  # already gone; never touch a successor
                except Exception as exc:
                    logger.warning("Harness reap failed (%s)", type(exc).__name__)
                finally:
                    with _lock:
                        _owned.get(scope, {}).pop(record[0].pid, None)
            with _lock:
                if not _owned.get(scope):
                    _owned.pop(scope, None)
                    timer = _retries.pop(scope, None)
                    if timer:
                        timer.cancel()
            if latest_hold:
                _retry(task_id, scope, latest_hold, cron)
        except Exception as exc:
            logger.warning("Harness scope cleanup failed (%s)", type(exc).__name__)
