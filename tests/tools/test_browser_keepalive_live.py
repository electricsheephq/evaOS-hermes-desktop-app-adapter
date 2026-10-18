"""Opt-in real daemon/CDP idle proof, using only isolated about:blank sessions.

HERMES_E2E_BROWSER=1 scripts/run_tests.sh -j 1 --file-retries 0 \
    tests/tools/test_browser_keepalive_live.py -m integration
"""
import contextlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

import psutil
import pytest

from tools import browser_tool_install as install


class IsolatedBrowser:
    """Only signal launched descendants or processes bearing this fresh profile."""

    def __init__(self, root, binary, chrome=None):
        self.root = Path(root)
        self.home = self.root / "home"
        self.home.mkdir()
        self.profile = self.root / "profile"
        self.sockets = self.root / "s"
        self.sockets.mkdir(mode=0o700)
        # Same per-session socket/idle environment as _agent_browser_command_env,
        # with an allowlist instead of inheriting real credentials or browser config.
        self.env = {key: os.environ[key] for key in
                    ("PATH", "TMPDIR", "SYSTEMROOT", "WINDIR") if key in os.environ}
        self.env.update(HOME=str(self.home), AGENT_BROWSER_SOCKET_DIR=str(self.sockets),
                        AGENT_BROWSER_IDLE_TIMEOUT_MS="20000", AGENT_BROWSER_HEADED="false",
                        AGENT_BROWSER_PROFILE=str(self.profile))
        if chrome:
            self.env["AGENT_BROWSER_EXECUTABLE_PATH"] = str(chrome)
        else:
            cache = Path.home() / ".agent-browser" / "browsers"
            if cache.is_dir():
                (self.home / ".agent-browser").mkdir()
                (self.home / ".agent-browser" / "browsers").symlink_to(cache, target_is_directory=True)
        self.argv = [binary, "--session", "probe", "--profile", str(self.profile), "--json"]
        self.owned = {}
        self.browser_pids = set()

    def processes(self):
        found = {}
        for proc in psutil.process_iter(["cmdline", "create_time"]):
            with contextlib.suppress(psutil.Error):
                if f"--user-data-dir={self.profile}" in (proc.info["cmdline"] or []):
                    self.owned[proc.pid] = proc
                    if not any(arg.startswith("--type=") for arg in proc.info["cmdline"]):
                        found[proc.pid] = proc
                        self.browser_pids.add(proc.pid)
        return found

    def command(self, *args):
        proc = subprocess.Popen(self.argv + list(args), env=self.env, cwd=self.home,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        parent = psutil.Process(proc.pid)
        self.owned[parent.pid] = parent
        deadline = time.monotonic() + 12
        try:
            while proc.poll() is None:
                with contextlib.suppress(psutil.Error):
                    for child in parent.children(recursive=True):
                        self.owned[child.pid] = child
                self.processes()
                if time.monotonic() >= deadline:
                    raise subprocess.TimeoutExpired(args[0], 12)
                time.sleep(0.01)
            stdout, stderr = proc.communicate(timeout=1)
            return proc.returncode, stdout, stderr
        finally:
            if proc.poll() is None:
                proc.kill()
                with contextlib.suppress(subprocess.TimeoutExpired):
                    proc.wait(timeout=2)

    def open(self):
        code, output, _ = self.command("open", "about:blank")
        if code:
            return False
        assert json.loads(output)["success"], "isolated open failed"
        assert self.processes(), "browser profile absent after open"
        return True

    def alive(self):
        return bool(self.processes())

    def live_owned(self):
        alive = []
        for proc in self.owned.values():
            with contextlib.suppress(psutil.Error):
                if proc.is_running() and proc.status() != psutil.STATUS_ZOMBIE:
                    alive.append(proc)
        return alive

    def cleanup(self):
        # close is scoped to this socket directory/session; never close --all.
        self.command("close")
        self.processes()
        psutil.wait_procs(list(self.owned.values()), timeout=3)
        for proc in self.live_owned():
            with contextlib.suppress(psutil.Error):
                proc.terminate()
        _, alive = psutil.wait_procs(list(self.owned.values()), timeout=3)
        for proc in alive:
            with contextlib.suppress(psutil.Error):
                proc.kill()
        psutil.wait_procs(alive, timeout=2)
        assert not self.live_owned(), "isolated processes survived cleanup"


def candidate_probe(browser, command, duration=45, period=6):
    assert browser.open(), "agent-browser/Chromium unavailable"
    initial = set(browser.processes())
    start = time.monotonic()
    beats = []
    while time.monotonic() - start < duration:
        time.sleep(period)
        code, _, _ = browser.command(*command)
        beats.append({"elapsed_s": round(time.monotonic() - start, 2), "exit": code,
                      "original_alive": initial <= set(browser.processes())})
    browser.command("close")
    deadline = time.monotonic() + 5
    while browser.alive() and time.monotonic() < deadline:
        time.sleep(0.1)
    assert not browser.alive(), "close did not stop original browser"
    before = set(browser.browser_pids)
    code, _, _ = browser.command(*command)
    # Detect a startup even if a command immediately tears down its replacement.
    time.sleep(1)
    return {"command": list(command), "beats": beats,
            "alive": all(b["original_alive"] for b in beats),
            "cold_exit": code, "cold_browser": browser.alive() or bool(browser.browser_pids - before),
            "cold_daemon": bool(browser.live_owned())}


def direct_cdp_probe(browser, heartbeat=None):
    from websockets.sync.client import connect

    assert browser.open(), "agent-browser/Chromium unavailable"
    code, output, _ = browser.command("get", "cdp-url")
    assert code == 0
    endpoint = json.loads(output)["data"]["cdpUrl"]
    original = set(browser.processes())
    start = time.monotonic()
    next_beat = start + 6
    calls = 0
    cdp_lost = False
    with connect(endpoint, open_timeout=5) as ws:
        while time.monotonic() - start < 45:
            now = time.monotonic()
            if heartbeat and now >= next_beat:
                heartbeat()
                next_beat = time.monotonic() + 6
            try:
                ws.send(json.dumps({"id": calls + 1, "method": "Browser.getVersion"}))
                reply = json.loads(ws.recv(timeout=3))
                assert reply.get("result"), "direct CDP command failed"
            except (OSError, TimeoutError):
                if heartbeat:
                    raise
                cdp_lost = True
                break
            except Exception as exc:
                from websockets.exceptions import ConnectionClosed
                if heartbeat or not isinstance(exc, ConnectionClosed):
                    raise
                cdp_lost = True
                break
            calls += 1
            time.sleep(1)
    elapsed = time.monotonic() - start
    # CDP closes before Chromium has finished exiting. Observe that bounded
    # teardown grace without sending another daemon command or restarting it.
    deadline = time.monotonic() + 5
    while cdp_lost and browser.alive() and time.monotonic() < deadline:
        time.sleep(0.1)
    return {"heartbeat": bool(heartbeat), "elapsed_s": round(elapsed, 2), "cdp_lost": cdp_lost,
            "cdp_calls": calls, "original_alive": original <= set(browser.processes())}


@pytest.mark.integration
@pytest.mark.macos_only
@pytest.mark.live_system_guard_bypass  # Signals only this test's recorded processes.
@pytest.mark.skipif(os.environ.get("HERMES_E2E_BROWSER") != "1",
                    reason="real-browser E2E: set HERMES_E2E_BROWSER=1 to opt in")
def test_managed_browser_real_idle_keepalive(monkeypatch, record_property):
    from tools import browser_tool as bt
    from tools import browser_tool_session as session

    try:
        binary = install._find_agent_browser()
    except FileNotFoundError:
        pytest.skip("agent-browser unavailable")
    if install._is_npx_agent_browser_sentinel(binary):
        pytest.skip("real installed agent-browser required; no downloads")
    with tempfile.TemporaryDirectory(prefix="bk-", dir=os.environ.get("TMPDIR")) as root:
        browser = IsolatedBrowser(root, binary)
        try:
            monkeypatch.setitem(bt._active_sessions, "keepalive-live", {"session_name": "probe"})
            monkeypatch.setattr(session, "_prepare_session_socket_dir", lambda name: str(browser.sockets))
            monkeypatch.setattr(session, "_agent_browser_command_env", lambda path: browser.env)
            # A fresh session has no stale socket or closing daemon to mask a launch.
            skipped = {"success": False, "skipped": "session_gone"}
            assert session._keepalive_managed_browser("keepalive-live", 5) == skipped
            assert not browser.alive() and not browser.live_owned()
            if not browser.open():
                pytest.skip("agent-browser/Chromium unavailable")
            browser.command("close")
            deadline = time.monotonic() + 5
            while browser.live_owned() and time.monotonic() < deadline:
                time.sleep(0.1)
            assert not browser.live_owned()
            before = set(browser.browser_pids)
            assert session._keepalive_managed_browser("keepalive-live", 5) == skipped
            assert not browser.alive() and not browser.live_owned()
            assert browser.browser_pids == before
            without = direct_cdp_probe(browser)
            assert without["cdp_lost"], without
            assert not without["original_alive"], without
            assert without["elapsed_s"] >= 15 and without["cdp_calls"] >= 2, without
            with_heartbeat = direct_cdp_probe(
                browser, lambda: session._keepalive_managed_browser("keepalive-live", 5))
            assert with_heartbeat["original_alive"], with_heartbeat
            assert with_heartbeat["elapsed_s"] >= 45 and with_heartbeat["cdp_calls"] >= 2, with_heartbeat
            record_property("idle_proof", json.dumps({"without_keepalive": without,
                                                       "with_keepalive": with_heartbeat}))
        finally:
            browser.cleanup()
