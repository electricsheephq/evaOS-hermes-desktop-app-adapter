"""Scope-owned browser-harness cleanup; shared defaults persist outside cron.

The CLI has its own interpreter, so ask it for its IPC paths instead of importing
the harness into Hermes or duplicating its runtime-directory rules.
"""
from contextlib import contextmanager
import json
import logging
from pathlib import Path
import threading
import uuid

import psutil

logger = logging.getLogger(__name__)
_OWNER_ENV = "_HERMES_HARNESS_OWNER"
_owned = {}
_lock = threading.Lock()

# The leading, unexecuted admin call bypasses CLI bootstrap (run.py cloud_admin).
# Neither a probe nor cleanup may start a replacement daemon.
_CONTROL = '''stop_remote_daemon() if False else None
import json, os
from browser_harness import _ipc
name = os.environ.get("BU_NAME", "default")
path = _ipc.pid_path(name)
try:
    raw = json.loads(path.read_text())
    pid = raw.get("pid") if isinstance(raw, dict) else raw
except (OSError, ValueError):
    pid = None
if os.environ.get("_HERMES_HARNESS_STOP") == str(pid) and _ipc.identify(name, timeout=1) == pid:
    sock, token = _ipc.connect(name, timeout=2)
    try:
        current = json.loads(path.read_text())
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
    """Track only freshly spawned daemons: reused ones cannot inherit this marker."""
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
                if _matches(process, marker, name=env.get("BU_NAME", "default")):
                    from tools.browser_use_cli import _backend_cache_key
                    record = (process, process.create_time(), marker, identity["path"], cmd, control_env,
                              env.get("BU_NAME", "default"), _backend_cache_key(task_id, session))
                    with _lock:
                        _owned.setdefault(task_id or "default", {})[pid] = record
        except Exception as exc:
            logger.warning("Harness ownership capture failed (%s)", type(exc).__name__)


def _held(records):
    from tools import browser_tool
    import time
    with browser_tool._cleanup_lock:
        return any(browser_tool._session_last_activity.get(record[-1], 0) > time.time()
                   for record in records)


def _stop(record):
    process, started, marker, path, cmd, env, name, key = record
    raw = json.loads(Path(path).read_text())
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

    A future activity timestamp is the Browserbase live-view hold. Leave the
    whole owning scope alone while held; hold expiry/provider cleanup owns it.
    """
    for task_id in task_ids:
        try:
            with _lock:
                records = list(_owned.get(task_id, {}).values())
            if not records or _held(records):
                continue
            for record in records:
                try:
                    if cron or record[-2] != "default":
                        _stop(record)
                except (psutil.NoSuchProcess, FileNotFoundError):
                    pass  # already gone; never touch a successor
                except Exception as exc:
                    logger.warning("Harness reap failed (%s)", type(exc).__name__)
                finally:
                    with _lock:
                        _owned.get(task_id, {}).pop(record[0].pid, None)
            with _lock:
                if not _owned.get(task_id):
                    _owned.pop(task_id, None)
        except Exception as exc:
            logger.warning("Harness scope cleanup failed (%s)", type(exc).__name__)
