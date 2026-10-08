"""Regression for adapter#406: scope ownership across real CLI/daemon processes."""
import json
import os
from contextlib import contextmanager
from contextvars import Context
from pathlib import Path
import socket
import sys
import time
from types import SimpleNamespace

import psutil
import pytest

from agent.client_lifecycle import ClientLifecycleMixin
from tools import browser_tool, browser_use_cli, browser_use_lifecycle


@pytest.fixture(autouse=True)
def timers(monkeypatch):
    """Drive delayed reaps deterministically without sleeping or leaving threads."""
    clock = SimpleNamespace(now=time.time(), pending=[])

    class Timer:
        def __init__(self, interval, callback):
            self.interval, self.callback = interval, callback
            self.daemon = False
            self.cancelled = False

        def start(self):
            assert self.daemon
            clock.pending.append(self)

        def cancel(self):
            self.cancelled = True

        def fire(self):
            assert not self.cancelled
            self.callback()

    monkeypatch.setattr(browser_use_lifecycle, "threading", SimpleNamespace(Timer=Timer))
    monkeypatch.setattr(browser_use_lifecycle, "time", SimpleNamespace(time=lambda: clock.now), raising=False)
    yield clock
    for name in ("_owned", "_borrows", "_borrow_keys", "_retries"):
        getattr(browser_use_lifecycle, name, {}).clear()


@contextmanager
def profile(home):
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    token = set_hermes_home_override(home)
    try:
        yield
    finally:
        reset_hermes_home_override(token)


@pytest.fixture
def harness(tmp_path, monkeypatch):
    """A minimal real harness protocol; no browser, credentials, or live home."""
    package = tmp_path / "browser_harness"
    package.mkdir()
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "_ipc.py").write_text('''
import json, os, socket
from pathlib import Path
root = Path(os.environ["BH_RUNTIME_DIR"])
def pid_path(name): return root / (name + ".pid")
def connect(name, timeout=1):
    s = socket.socket()
    s.settimeout(timeout)
    s.connect(("127.0.0.1", int((root / (name + ".port")).read_text(encoding="utf-8"))))
    return s, None
def request(sock, token, req):
    sock.sendall((json.dumps(req) + "\\n").encode())
    return json.loads(sock.recv(4096))
def identify(name, timeout=1):
    s, token = connect(name, timeout)
    try: return request(s, token, {"meta": "ping"})["pid"]
    finally: s.close()
''', encoding="utf-8")
    (package / "daemon.py").write_text('''
import json, os, socket
from . import _ipc
name = os.environ.get("BU_NAME", "default")
s = socket.socket()
s.bind(("127.0.0.1", 0))
s.listen()
(_ipc.root / (name + ".port")).write_text(str(s.getsockname()[1]), encoding="utf-8")
_ipc.pid_path(name).write_text(str(os.getpid()), encoding="utf-8")
while True:
    c, _ = s.accept()
    with c:
        req = json.loads(c.recv(4096))
        if req["meta"] == "shutdown":
            (_ipc.root / (name + ".stopped")).write_text(str(os.getpid()), encoding="utf-8")
            c.sendall(b'{"ok": true}\\n')
            break
        c.sendall((json.dumps({"pong": True, "pid": os.getpid()}) + "\\n").encode())
''', encoding="utf-8")
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
''', encoding="utf-8")
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
            process = psutil.Process(int(path.read_text(encoding="utf-8")))
            argv = process.cmdline()
            if "browser_harness.daemon" in argv and process.cwd() == str(tmp_path):
                # Daemons detach from the test subtree; use their verified IPC,
                # retaining the repository live-system signal guard.
                port = int(path.with_suffix(".port").read_text(encoding="utf-8"))
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
    return int((harness / ((name or "default") + ".pid")).read_text(encoding="utf-8"))


def close(owner, platform="cron"):
    agent = SimpleNamespace(_process_owner_task_ids={owner}, platform=platform)
    ClientLifecycleMixin._close_task_resources(agent, "session-id")


@pytest.mark.parametrize("name", ["scheduled", ""])
def test_cron_close_stops_only_scope_started_daemon(harness, name):
    owned_pid = start(harness, "cron-owner", name)
    unrelated_pid = start(harness, "interactive-owner", "interactive")
    close("cron-owner")
    assert (harness / ((name or "default") + ".stopped")).read_text(encoding="utf-8") == str(owned_pid)
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
        assert (harness / "scheduled.stopped").read_text(encoding="utf-8") == str(pid)
    else:
        assert psutil.pid_exists(pid)
        assert not (harness / ((name or "default") + ".stopped")).exists()
    if scenario == "failure":
        assert "Harness reap failed" in caplog.text


def test_same_task_id_is_isolated_across_served_profiles(harness):
    with profile(harness / "home-a"):
        pid_a = start(harness, "same-task", "session-a")
    with profile(harness / "home-b"):
        pid_b = start(harness, "same-task", "session-b")
    with profile(harness / "home-a"):
        close("same-task")
    assert (harness / "session-a.stopped").read_text(encoding="utf-8") == str(pid_a)
    assert psutil.pid_exists(pid_b)
    assert not (harness / "session-b.stopped").exists()
    assert any(pid_b in records for records in browser_use_lifecycle._owned.values())
    with profile(harness / "home-b"):
        close("same-task")
    assert (harness / "session-b.stopped").read_text(encoding="utf-8") == str(pid_b)


def test_hold_retry_reaps_after_expiry_without_stranding_siblings(harness, timers):
    with profile(harness / "held-home"):
        held = start(harness, "hold-owner", "held")
        latest = start(harness, "hold-owner", "latest")
        unheld = start(harness, "hold-owner", "unheld")
        hold_key = browser_use_cli._backend_cache_key("hold-owner", "held")
        latest_key = browser_use_cli._backend_cache_key("hold-owner", "latest")
        browser_tool._session_last_activity[hold_key] = timers.now + 10
        browser_tool._session_last_activity[latest_key] = timers.now + 20
        close("hold-owner")
        close("hold-owner")  # one pending timer per profile/task, even on repeated close
    assert psutil.pid_exists(held) and psutil.pid_exists(latest)
    assert not (harness / "held.stopped").exists()
    assert (harness / "unheld.stopped").read_text(encoding="utf-8") == str(unheld)
    assert len(timers.pending) == 1
    assert timers.pending[0].interval == pytest.approx(25)
    # A renewed hold is checked by the retry, which runs from an empty thread context.
    browser_tool._session_last_activity[latest_key] = timers.now + 7200
    timers.now += 25
    Context().run(timers.pending[0].fire)
    assert (harness / "held.stopped").read_text(encoding="utf-8") == str(held)
    assert psutil.pid_exists(latest)
    assert len(timers.pending) == 2
    assert timers.pending[1].interval == 3600  # cap revisits rather than killing a held daemon
    timers.now = browser_tool._session_last_activity[latest_key] + 5
    Context().run(timers.pending[1].fire)
    assert (harness / "latest.stopped").read_text(encoding="utf-8") == str(latest)
    assert not browser_use_lifecycle._owned
    assert not browser_use_lifecycle._retries


@pytest.mark.parametrize("name", ["adopted", ""])
def test_creator_transfers_daemon_to_borrower_until_borrower_closes(harness, name):
    pid = start(harness, "creator", name)
    assert start(harness, "borrower", name) == pid
    close("creator")
    stopped = harness / ((name or "default") + ".stopped")
    assert psutil.pid_exists(pid)
    assert not stopped.exists()
    close("borrower", "cli")
    if name:
        assert stopped.read_text(encoding="utf-8") == str(pid)
    else:
        assert psutil.pid_exists(pid)
        assert not stopped.exists()  # cron-created default adopted by an interactive scope persists
    assert not browser_use_lifecycle._owned
    assert not browser_use_lifecycle._borrows


@pytest.mark.parametrize("owner", [None, ""])
def test_falsy_owner_uses_same_legacy_key_at_capture_and_cleanup(harness, owner):
    pid = start(harness, owner, "legacy")
    close(owner)
    assert (harness / "legacy.stopped").read_text(encoding="utf-8") == str(pid)
