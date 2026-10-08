"""Regression for adapter#406: scope ownership across real CLI/daemon processes."""
import json
import os
from pathlib import Path
import socket
import sys
import time
from types import SimpleNamespace

import psutil
import pytest

from agent.client_lifecycle import ClientLifecycleMixin
from tools import browser_tool, browser_use_cli


@pytest.fixture
def harness(tmp_path, monkeypatch):
    """A minimal real harness protocol; no browser, credentials, or live home."""
    package = tmp_path / "browser_harness"
    package.mkdir()
    (package / "__init__.py").write_text("")
    (package / "_ipc.py").write_text('''
import json, os, socket
from pathlib import Path
root = Path(os.environ["BH_RUNTIME_DIR"])
def pid_path(name): return root / (name + ".pid")
def connect(name, timeout=1):
    s = socket.socket()
    s.settimeout(timeout)
    s.connect(("127.0.0.1", int((root / (name + ".port")).read_text())))
    return s, None
def request(sock, token, req):
    sock.sendall((json.dumps(req) + "\\n").encode())
    return json.loads(sock.recv(4096))
def identify(name, timeout=1):
    s, token = connect(name, timeout)
    try: return request(s, token, {"meta": "ping"})["pid"]
    finally: s.close()
''')
    (package / "daemon.py").write_text('''
import json, os, socket
from . import _ipc
name = os.environ.get("BU_NAME", "default")
s = socket.socket()
s.bind(("127.0.0.1", 0))
s.listen()
(_ipc.root / (name + ".port")).write_text(str(s.getsockname()[1]))
_ipc.pid_path(name).write_text(str(os.getpid()))
while True:
    c, _ = s.accept()
    with c:
        req = json.loads(c.recv(4096))
        if req["meta"] == "shutdown":
            (_ipc.root / (name + ".stopped")).write_text(str(os.getpid()))
            c.sendall(b'{"ok": true}\\n')
            break
        c.sendall((json.dumps({"pong": True, "pid": os.getpid()}) + "\\n").encode())
''')
    cli = tmp_path / "cli.py"
    cli.write_text('''
import os, subprocess, sys, time
sys.path.insert(0, os.environ["BH_RUNTIME_DIR"])
from browser_harness import _ipc
code = sys.stdin.read()
if code.startswith("stop_remote_daemon("):
    exec(code)
else:
    name = os.environ.get("BU_NAME", "default")
    if not _ipc.pid_path(name).exists():
        subprocess.Popen([sys.executable, "-m", "browser_harness.daemon"],
                         cwd=os.environ["BH_RUNTIME_DIR"], env=os.environ,
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.monotonic() + 3
        while not _ipc.pid_path(name).exists():
            if time.monotonic() > deadline: raise RuntimeError("daemon did not start")
            time.sleep(.01)
    print("ok")
''')
    monkeypatch.setattr(browser_use_cli, "_find_cli", lambda: [sys.executable, str(cli)])
    monkeypatch.setattr(browser_use_cli, "_base_subprocess_env", lambda: {
        "PATH": os.environ["PATH"], "HOME": str(tmp_path), "BH_RUNTIME_DIR": str(tmp_path)})
    monkeypatch.setattr(browser_use_cli, "_route_backend", lambda *args: None)
    monkeypatch.setattr(browser_use_cli, "_attach_vault_supervisor", lambda *args: None)
    monkeypatch.setattr(browser_use_cli, "is_legacy_browser_use_cloud_config", lambda cfg: False)
    monkeypatch.setattr(browser_use_cli, "_read_browser_cfg", lambda: {})
    monkeypatch.setattr(browser_tool, "_session_last_activity", {})
    import run_agent
    monkeypatch.setattr(run_agent, "cleanup_vm", lambda *args: None)
    monkeypatch.setattr(run_agent, "cleanup_browser", lambda *args: None)
    monkeypatch.setattr("tools.computer_use.tool.release_computer_use_session", lambda *args: None)
    yield tmp_path
    for path in tmp_path.glob("*.pid"):
        try:
            process = psutil.Process(int(path.read_text()))
            argv = process.cmdline()
            if "browser_harness.daemon" in argv and process.cwd() == str(tmp_path):
                # Daemons detach from the test subtree; use their verified IPC,
                # retaining the repository live-system signal guard.
                port = int(path.with_suffix(".port").read_text())
                with socket.create_connection(("127.0.0.1", port), timeout=2) as sock:
                    sock.sendall(b'{"meta": "ping"}\n')
                    assert json.loads(sock.recv(4096))["pid"] == process.pid
                with socket.create_connection(("127.0.0.1", port), timeout=2) as sock:
                    sock.sendall(b'{"meta": "shutdown"}\n')
                    sock.recv(4096)
                process.wait(timeout=3)
        except psutil.NoSuchProcess:
            pass
    # Clear only this test's in-process receipts when running against the candidate.
    lifecycle = sys.modules.get("tools.browser_use_lifecycle")
    if lifecycle:
        lifecycle._owned.clear()


def start(harness, owner, name=""):
    result = json.loads(browser_use_cli.browser_exec("print('ok')", session=name, task_id=owner))
    assert result["success"], result
    return int((harness / ((name or "default") + ".pid")).read_text())


def close(owner, platform="cron"):
    agent = SimpleNamespace(_process_owner_task_ids={owner}, platform=platform)
    ClientLifecycleMixin._close_task_resources(agent, "session-id")


@pytest.mark.parametrize("name", ["scheduled", ""])
def test_cron_close_stops_only_scope_started_daemon(harness, name):
    owned_pid = start(harness, "cron-owner", name)
    unrelated_pid = start(harness, "interactive-owner", "interactive")
    close("cron-owner")
    assert (harness / ((name or "default") + ".stopped")).read_text() == str(owned_pid)
    assert psutil.pid_exists(unrelated_pid)
    close("cron-owner")  # repeated close cannot stop another daemon
    assert not (harness / "interactive.stopped").exists()


@pytest.mark.parametrize("scenario", ["recycled-pid", "shared-default", "hold", "failure", "interactive-named"])
def test_scope_end_respects_identity_sharing_hold_and_errors(harness, monkeypatch, caplog, scenario):
    name = "" if scenario == "shared-default" else "scheduled"
    pid = start(harness, "interactive-owner" if scenario == "shared-default" else "cron-owner", name)
    if scenario == "recycled-pid":
        # Same PID file number, but process fingerprint no longer matches.
        original = psutil.Process.create_time
        monkeypatch.setattr(psutil.Process, "create_time", lambda self: original(self) + 1)
    elif scenario == "shared-default":
        assert start(harness, "cron-owner", name) == pid  # reuse is not ownership
        close("interactive-owner", "cli")
    elif scenario == "hold":
        key = browser_use_cli._backend_cache_key("cron-owner", name)
        browser_tool._session_last_activity[key] = time.time() + 900
    elif scenario == "failure":
        monkeypatch.setattr(Path, "read_text", lambda *args, **kwargs: (_ for _ in ()).throw(OSError("unreadable")))
    try:
        close("cron-owner", "cli" if scenario == "interactive-named" else "cron")
    finally:
        if scenario == "failure":
            monkeypatch.undo()  # restore filesystem reads even on the unfixed base
    if scenario == "interactive-named":
        assert (harness / "scheduled.stopped").read_text() == str(pid)
    else:
        assert psutil.pid_exists(pid)
        assert not (harness / ((name or "default") + ".stopped")).exists()
    if scenario == "failure":
        assert "Harness reap failed" in caplog.text
