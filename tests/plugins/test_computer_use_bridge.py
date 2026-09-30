"""computer-use (Mac bridge) gateway plugin: the dashboard hub and the stdio MCP shim.

The hub runs its real Unix socket server; the "Mac" is a fake WebSocket that records frames; the shim is
the real class with its stdout captured. Nothing here drives a real computer.
"""

from __future__ import annotations

import asyncio
import importlib.util
import io
import json
import os
import shutil
import stat
import tempfile
import threading
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
PLUGIN_DIR = REPO / "optional-plugins" / "computer-use"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


api = _load("computer_use_plugin_api", PLUGIN_DIR / "dashboard" / "plugin_api.py")
shim_mod = _load("computer_use_shim", PLUGIN_DIR / "mcp_stdio_shim.py")

OFFLINE = "Your Mac isn't connected. Ask the user to open evaOS Agent → Computer Use → Enable."
DROPPED = ("The connection to the user's Mac dropped during this action; it may or may not have run. "
           "Check the Mac's state before retrying.")


@pytest.fixture
def home():
    # AF_UNIX paths are capped at 104 bytes on macOS; pytest's tmp_path is too deep for that.
    path = Path(tempfile.mkdtemp(prefix="cu"))
    yield path
    shutil.rmtree(path, ignore_errors=True)


class FakeMac:
    def __init__(self):
        self.sent, self.closed = [], None

    async def send_text(self, text):
        self.sent.append(json.loads(text))

    async def close(self, code=1000, reason=""):
        self.closed = (code, reason)

    def of(self, kind):
        return [f for f in self.sent if f.get("t") == kind]


HELLO = {"t": "hello", "v": 1, "cua_version": "9.9.9", "permission_mode": "unrestricted",
         "tools": [{"name": "click", "inputSchema": {"type": "object"}}]}


async def _until(predicate, timeout=3.0):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.01)


class LineClient:
    """A raw shim-side socket client (what mcp_stdio_shim does, minus MCP)."""

    def __init__(self, path):
        self.reader = self.writer = None
        self.path = path
        self.frames = []

    async def open(self):
        self.reader, self.writer = await asyncio.open_unix_connection(str(self.path))
        asyncio.get_running_loop().create_task(self._pump())

    async def _pump(self):
        while line := await self.reader.readline():
            self.frames.append(json.loads(line))

    async def send(self, frame):
        self.writer.write((json.dumps(frame) + "\n").encode())
        await self.writer.drain()


def test_socket_is_0600_in_a_0700_dir_and_hello_is_cached(home):
    async def run():
        hub = api.Hub(home)
        await hub.ensure_socket()
        mac = FakeMac()
        await hub.attach_mac(mac)
        await hub.on_mac_frame(mac, HELLO)
        assert stat.S_IMODE(os.stat(hub.sock_path).st_mode) == 0o600
        assert stat.S_IMODE(os.stat(hub.dir).st_mode) == 0o700
        assert stat.S_ISSOCK(os.stat(hub.sock_path).st_mode)
        cached = json.loads((hub.dir / "tools.json").read_text())
        assert cached["cua_version"] == "9.9.9" and cached["tools"] == HELLO["tools"]
    asyncio.run(run())


def test_newest_mac_connection_wins(home):
    async def run():
        hub = api.Hub(home)
        await hub.ensure_socket()
        first, second = FakeMac(), FakeMac()
        await hub.attach_mac(first)
        await hub.on_mac_frame(first, HELLO)
        client = LineClient(hub.sock_path)
        await client.open()
        await _until(lambda: first.of("open"))
        await hub.on_mac_frame(second, {"t": "msg", "c": "x", "m": {}})  # no hello yet: not the Mac
        assert hub.mac is first and first.closed is None
        await hub.on_mac_frame(second, HELLO)
        assert first.closed == (4000, "replaced by a newer connection")
        assert hub.mac is second and hub.ready
        await _until(lambda: {"t": "offline"} in client.frames and second.of("open"))
        # The old connection's late frames are ignored.
        await hub.on_mac_frame(first, {"t": "msg", "c": first.of("open")[0]["c"], "m": {"id": 1, "result": {}}})
        assert not any(f.get("t") == "msg" for f in client.frames)
        await hub.detach_mac(first)  # a stale close must not take the new Mac down
        assert hub.mac is second
    asyncio.run(run())


def test_routes_each_shim_on_its_own_conn_id(home):
    async def run():
        hub = api.Hub(home)
        await hub.ensure_socket()
        mac = FakeMac()
        await hub.attach_mac(mac)
        await hub.on_mac_frame(mac, HELLO)
        a, b = LineClient(hub.sock_path), LineClient(hub.sock_path)
        await a.open()
        await b.open()
        await _until(lambda: len(mac.of("open")) == 2 and {"t": "online"} in a.frames and {"t": "online"} in b.frames)
        cid_a, cid_b = (f["c"] for f in mac.of("open"))
        assert cid_a != cid_b
        await a.send({"t": "msg", "m": {"jsonrpc": "2.0", "id": 7, "method": "tools/call"}})
        await _until(lambda: mac.of("msg"))
        assert mac.of("msg")[0] == {"t": "msg", "c": cid_a, "m": {"jsonrpc": "2.0", "id": 7, "method": "tools/call"}}
        await hub.on_mac_frame(mac, {"t": "msg", "c": cid_b, "m": {"jsonrpc": "2.0", "id": 3, "result": {"ok": 1}}})
        await _until(lambda: any(f.get("t") == "msg" for f in b.frames))
        assert not any(f.get("t") == "msg" for f in a.frames)
        a.writer.close()
        await _until(lambda: mac.of("close"))
        assert mac.of("close") == [{"t": "close", "c": cid_a}]
        await hub.detach_mac(mac)
        await _until(lambda: {"t": "offline"} in b.frames)
    asyncio.run(run())


def test_child_exit_on_the_mac_reopens_the_conn(home, monkeypatch):
    monkeypatch.setattr(api, "REOPEN_DELAY_SECONDS", 0.01)

    async def run():
        hub = api.Hub(home)
        await hub.ensure_socket()
        mac = FakeMac()
        await hub.attach_mac(mac)
        await hub.on_mac_frame(mac, HELLO)
        client = LineClient(hub.sock_path)
        await client.open()
        await _until(lambda: mac.of("open"))
        cid = mac.of("open")[0]["c"]
        await hub.on_mac_frame(mac, {"t": "close", "c": cid})
        await _until(lambda: len(mac.of("open")) == 2)
        assert client.frames == [{"t": "online"}, {"t": "offline"}, {"t": "online"}]
    asyncio.run(run())


# --- the stdio shim -------------------------------------------------------------------------------


class Up:
    """The shim's dashboard socket, as a list."""

    def __init__(self):
        self.lines = []

    def sendall(self, data):
        self.lines += [json.loads(line) for line in data.decode().splitlines()]


def _shim(home, *, sock=True):
    out = io.StringIO()
    shim = shim_mod.Shim(str(home / "computer-use" / "bridge.sock"), out=out)
    if sock:
        shim.sock = Up()
    return shim, out


def _out(out):
    return [json.loads(line) for line in out.getvalue().splitlines()]


INIT = {"jsonrpc": "2.0", "id": 0, "method": "initialize",
        "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "hermes"}}}


def test_offline_tools_list_uses_the_cache_then_the_bundled_default(home):
    shim, out = _shim(home, sock=False)
    shim.from_hermes(INIT)
    shim.from_hermes({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    init, listed = _out(out)
    assert init["result"]["capabilities"]["tools"]["listChanged"] is True
    bundled = json.loads((PLUGIN_DIR / "default_tools.json").read_text())
    assert init["result"]["serverInfo"]["version"] == bundled["cua_version"] == "0.30.2"
    assert listed["result"]["tools"] == bundled["tools"] and len(bundled["tools"]) > 40

    (home / "computer-use").mkdir()
    (home / "computer-use" / "tools.json").write_text(json.dumps({"cua_version": "1.2.3", "tools": [{"name": "x"}]}))
    shim.from_hermes({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    assert _out(out)[-1] == {"jsonrpc": "2.0", "id": 2, "result": {"tools": [{"name": "x"}]}}


def test_offline_tools_call_is_the_exact_sentence(home):
    shim, out = _shim(home, sock=False)
    shim.from_hermes({"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "click"}})
    assert _out(out) == [{"jsonrpc": "2.0", "id": 5,
                          "result": {"content": [{"type": "text", "text": OFFLINE}], "isError": True}}]
    assert shim_mod.OFFLINE_TEXT == OFFLINE


def test_online_passthrough_is_message_for_message(home):
    shim, out = _shim(home)
    shim.from_dashboard({"t": "online"})
    shim.from_hermes(INIT)
    call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "click", "arguments": {"x": 1}}}
    shim.from_hermes(call)
    assert shim.sock.lines == [{"t": "msg", "m": INIT}, {"t": "msg", "m": call}]
    reply = {"jsonrpc": "2.0", "id": 1, "result": {"content": [{"type": "text", "text": "ok"}]}}
    shim.from_dashboard({"t": "msg", "m": reply})
    assert _out(out) == [reply]  # no list_changed: Hermes initialized while online
    assert shim.pending == {0: "initialize"}


def test_mac_arriving_mid_session_reinitializes_and_announces_list_changed(home):
    shim, out = _shim(home)
    shim.from_hermes(INIT)  # offline: answered locally
    shim.from_dashboard({"t": "online"})
    assert shim.sock.lines == [
        {"t": "msg", "m": {"jsonrpc": "2.0", "id": "my-mac-reinit", "method": "initialize", "params": INIT["params"]}},
        {"t": "msg", "m": {"jsonrpc": "2.0", "method": "notifications/initialized"}}]
    shim.from_dashboard({"t": "msg", "m": {"jsonrpc": "2.0", "id": "my-mac-reinit", "result": {}}})  # swallowed
    assert _out(out)[1:] == [{"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}]


def test_going_offline_answers_in_flight_requests(home):
    shim, out = _shim(home)
    shim.from_dashboard({"t": "online"})
    shim.from_hermes({"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {"name": "click"}})
    shim.from_hermes({"jsonrpc": "2.0", "id": 10, "method": "resources/read", "params": {}})
    shim.from_dashboard({"t": "offline"})
    by_id = {m["id"]: m for m in _out(out)}
    # In flight when the link dropped: it may or may not have run.
    assert by_id[9]["result"]["content"][0]["text"] == DROPPED and by_id[9]["result"]["isError"] is True
    assert by_id[10]["error"]["code"] == -32601
    shim.from_hermes({"jsonrpc": "2.0", "id": 11, "method": "tools/call", "params": {"name": "click"}})
    assert len(shim.sock.lines) == 2  # offline now: nothing more goes up
    # A new call while offline gets the offline sentence.
    assert _out(out)[-1]["result"]["content"][0]["text"] == OFFLINE
    assert shim_mod.DROPPED_TEXT == DROPPED


def test_shim_process_end_to_end_against_the_hub(home):
    """The real shim (its socket thread + retry) against the real hub socket and a fake Mac."""
    loop = asyncio.new_event_loop()
    hub, mac = api.Hub(home), FakeMac()
    threading.Thread(target=loop.run_forever, daemon=True).start()
    call = lambda coro: asyncio.run_coroutine_threadsafe(coro, loop).result(5)  # noqa: E731
    stdout = io.StringIO()
    shim = shim_mod.Shim(str(hub.sock_path), out=stdout)
    shim_mod.RETRY_SECONDS = 0.05
    threading.Thread(target=shim.socket_loop, daemon=True).start()
    try:
        shim.from_hermes(INIT)  # no dashboard socket yet -> answered offline
        call(hub.ensure_socket())
        call(hub.attach_mac(mac))
        call(hub.on_mac_frame(mac, HELLO))
        deadline = time.monotonic() + 5
        while not shim.online and time.monotonic() < deadline:
            time.sleep(0.02)
        assert shim.online
        opened = mac.of("open")[0]["c"]
        deadline = time.monotonic() + 5
        while len(mac.of("msg")) < 2 and time.monotonic() < deadline:
            time.sleep(0.02)
        assert [f["m"].get("method") for f in mac.of("msg")] == ["initialize", "notifications/initialized"]
        assert all(f["c"] == opened for f in mac.of("msg"))
        assert _out(stdout)[-1] == {"jsonrpc": "2.0", "method": "notifications/tools/list_changed"}
    finally:
        loop.call_soon_threadsafe(loop.stop)


def test_manifest_mounts_the_api_without_a_tab():
    manifest = json.loads((PLUGIN_DIR / "dashboard" / "manifest.json").read_text())
    assert manifest["name"] == "computer-use" and manifest["api"] == "plugin_api.py" and manifest["tab"]["hidden"]
    assert sorted(r.path for r in api.router.routes) == ["/available", "/bridge"]


# --- review round 2 -------------------------------------------------------------------------------


def test_a_stale_hello_handler_does_not_duplicate_opens_on_the_newer_mac(home):
    """Mac 1's hello loop pauses in a shim write; Mac 2 takes over and opens every shim; Mac 1's loop then
    resumes. The newer Mac must see each conn opened once (the review's probe saw a, b, b)."""
    async def run():
        hub = api.Hub(home)
        await hub.ensure_socket()
        a, b = LineClient(hub.sock_path), LineClient(hub.sock_path)
        await a.open()
        await _until(lambda: len(hub.shims) == 1)
        await b.open()
        await _until(lambda: len(hub.shims) == 2)
        cid_a, cid_b = list(hub.shims)

        gate, paused = asyncio.Event(), asyncio.Event()
        real_to_shim = hub._to_shim

        async def slow_first_online(cid, frame):
            if frame == {"t": "online"} and not paused.is_set():
                paused.set()
                await gate.wait()
            await real_to_shim(cid, frame)

        hub._to_shim = slow_first_online
        mac1, mac2 = FakeMac(), FakeMac()
        await hub.attach_mac(mac1)
        old_hello = asyncio.create_task(hub.on_mac_frame(mac1, HELLO))
        await paused.wait()  # Mac 1 opened a and is stuck telling shim a it is online
        await hub.attach_mac(mac2)
        await hub.on_mac_frame(mac2, HELLO)
        gate.set()
        await old_hello
        assert [f["c"] for f in mac2.of("open")] == [cid_a, cid_b]
        assert [f["c"] for f in mac1.of("open")] == [cid_a]
    asyncio.run(run())


def test_a_70kb_call_and_an_8mb_result_cross_the_socket_intact(home):
    loop = asyncio.new_event_loop()
    hub, mac = api.Hub(home), FakeMac()
    threading.Thread(target=loop.run_forever, daemon=True).start()
    call = lambda coro: asyncio.run_coroutine_threadsafe(coro, loop).result(10)  # noqa: E731
    stdout = io.StringIO()
    shim = shim_mod.Shim(str(hub.sock_path), out=stdout)
    shim_mod.RETRY_SECONDS = 0.05
    try:
        call(hub.ensure_socket())
        call(hub.attach_mac(mac))
        call(hub.on_mac_frame(mac, HELLO))
        threading.Thread(target=shim.socket_loop, daemon=True).start()
        deadline = time.monotonic() + 5
        while not shim.online and time.monotonic() < deadline:
            time.sleep(0.02)
        cid = mac.of("open")[0]["c"]

        big_call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                    "params": {"name": "type_text", "arguments": {"text": "é" * 35_000}}}  # 70 KB of UTF-8
        shim.from_hermes(big_call)
        deadline = time.monotonic() + 5
        while not mac.of("msg") and time.monotonic() < deadline:
            time.sleep(0.02)
        assert mac.of("msg") == [{"t": "msg", "c": cid, "m": big_call}]

        result = {"jsonrpc": "2.0", "id": 1,
                  "result": {"content": [{"type": "image", "mimeType": "image/png", "data": "A" * (8 * 1024 * 1024)}]}}
        call(hub.on_mac_frame(mac, {"t": "msg", "c": cid, "m": result}))
        deadline = time.monotonic() + 10
        while not stdout.getvalue().endswith("\n") and time.monotonic() < deadline:
            time.sleep(0.05)
        assert _out(stdout) == [result]
    finally:
        loop.call_soon_threadsafe(loop.stop)


def test_over_limit_frames_fail_that_call_and_keep_the_connection(home, monkeypatch):
    shim, out = _shim(home)
    shim.from_dashboard({"t": "online"})
    monkeypatch.setattr(shim_mod, "MAX_MESSAGE_BYTES", 1000)
    shim.from_hermes({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"text": "x" * 2000}})
    assert shim.sock.lines == [] and shim.pending == {}
    assert _out(out)[0]["id"] == 4 and _out(out)[0]["error"]["code"] == -32000

    monkeypatch.setattr(api, "LINE_LIMIT", 1000)

    async def run():
        hub = api.Hub(home)
        await hub.ensure_socket()
        mac = FakeMac()
        await hub.attach_mac(mac)
        await hub.on_mac_frame(mac, HELLO)
        client = LineClient(hub.sock_path)
        await client.open()
        await _until(lambda: mac.of("open"))
        await client.send({"t": "msg", "m": {"id": 1, "pad": "y" * 5000}})
        await client.send({"t": "msg", "m": {"id": 2}})
        await _until(lambda: mac.of("msg"))
        assert [f["m"]["id"] for f in mac.of("msg")] == [2]
        assert not mac.of("close")
    asyncio.run(run())


# --- pilot fix round 1 ----------------------------------------------------------------------------


class RouteWs(FakeMac):
    """What the ``/bridge`` route sees: frames arrive through ``inbox``; ``None`` is a disconnect."""

    def __init__(self):
        super().__init__()
        self.inbox: asyncio.Queue = asyncio.Queue()

    async def accept(self):
        pass

    async def receive_text(self):
        item = await self.inbox.get()
        if item is None:
            raise api.WebSocketDisconnect(1000)
        return json.dumps(item)


@pytest.fixture
def route(home, monkeypatch):
    monkeypatch.setattr(api, "_ws_upgrade_authorized", lambda ws: True)
    monkeypatch.setattr(api, "_current_home", lambda: home)
    monkeypatch.setattr(api, "_hubs", {})
    return lambda: api.hub_for(home)


def test_hub_answers_ping_and_ignores_unknown_frames(route):
    async def run():
        ws = RouteWs()
        task = asyncio.create_task(api.mac_bridge(ws))
        await ws.inbox.put({"t": "ping"})
        await ws.inbox.put({"t": "something-new", "x": 1})
        await ws.inbox.put(HELLO)
        await _until(lambda: route().ready)
        await ws.inbox.put({"t": "ping"})
        await _until(lambda: len(ws.of("pong")) == 2)
        assert ws.closed is None
        await ws.inbox.put(None)
        await task
        assert route().mac is None
    asyncio.run(run())


def test_an_upgrade_that_never_says_hello_does_not_evict_the_live_mac(route):
    async def run():
        live, silent = RouteWs(), RouteWs()
        live_task = asyncio.create_task(api.mac_bridge(live))
        await live.inbox.put(HELLO)
        await _until(lambda: route().ready)
        silent_task = asyncio.create_task(api.mac_bridge(silent))
        await silent.inbox.put({"t": "ping"})
        await silent.inbox.put({"t": "msg", "c": "x", "m": {"id": 1}})
        await _until(lambda: silent.of("pong"))
        await silent.inbox.put(None)
        await silent_task
        assert live.closed is None and route().mac is live and route().ready
        await live.inbox.put(None)
        await live_task
    asyncio.run(run())


def test_a_silent_mac_is_dropped_and_in_flight_calls_are_answered(route, monkeypatch):
    """No frame for RECEIVE_TIMEOUT_SECONDS: the hub drops the Mac, every shim goes offline, and a call already
    on the Mac is answered at once (the real shim, over the real socket)."""
    monkeypatch.setattr(api, "RECEIVE_TIMEOUT_SECONDS", 0.3)
    monkeypatch.setattr(shim_mod, "RETRY_SECONDS", 0.05)
    loop = asyncio.new_event_loop()
    threading.Thread(target=loop.run_forever, daemon=True).start()
    call = lambda coro: asyncio.run_coroutine_threadsafe(coro, loop).result(5)  # noqa: E731
    try:
        ws = call(asyncio.sleep(0, RouteWs()))  # built on the hub's loop
        task = asyncio.run_coroutine_threadsafe(api.mac_bridge(ws), loop)
        call(ws.inbox.put(HELLO))
        stdout = io.StringIO()
        shim = shim_mod.Shim(str(route().sock_path), out=stdout)
        threading.Thread(target=shim.socket_loop, daemon=True).start()
        deadline = time.monotonic() + 5
        while not shim.online and time.monotonic() < deadline:
            call(ws.inbox.put({"t": "ping"}))  # keep the link alive until the shim is online
            time.sleep(0.05)
        assert shim.online
        shim.from_hermes({"jsonrpc": "2.0", "id": 21, "method": "tools/call", "params": {"name": "click"}})
        started = time.monotonic()
        task.result(5)  # the route returns on its own: no frame for 0.3 s
        deadline = time.monotonic() + 5
        while shim.online and time.monotonic() < deadline:
            time.sleep(0.02)
        assert not shim.online and time.monotonic() - started < 3
        assert ws.closed == (1001, "no frames")
        assert route().mac is None
        answer = next(m for m in _out(stdout) if m.get("id") == 21)
        assert answer["result"]["content"][0]["text"] == DROPPED
    finally:
        loop.call_soon_threadsafe(loop.stop)


def test_a_socket_error_at_setup_closes_with_a_retryable_code(route, monkeypatch):
    async def run():
        async def broken(self):
            raise OSError("read-only file system")

        monkeypatch.setattr(api.Hub, "ensure_socket", broken)
        ws = RouteWs()
        await api.mac_bridge(ws)
        assert ws.closed == (1011, "bridge socket unavailable")  # not 4000: the Mac retries
    asyncio.run(run())


def test_a_repeat_hello_gives_every_conn_a_fresh_child(home):
    async def run():
        hub = api.Hub(home)
        await hub.ensure_socket()
        mac = FakeMac()
        await hub.on_mac_frame(mac, HELLO)
        client = LineClient(hub.sock_path)
        await client.open()
        await _until(lambda: mac.of("open"))
        await hub.on_mac_frame(mac, HELLO)  # the Mac restarted its daemon
        await _until(lambda: len(client.frames) == 3)
        assert client.frames == [{"t": "online"}, {"t": "offline"}, {"t": "online"}]
        assert len(mac.of("open")) == 2 and mac.closed is None
    asyncio.run(run())


def test_reopen_backs_off_2s_doubling_to_60s_and_resets_after_30s_open(home, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(api, "_clock", lambda: clock[0])
    hub = api.Hub(home)
    assert [hub._reopen_delay("c") for _ in range(7)] == [2, 4, 8, 16, 32, 60, 60]
    hub._opened_at["c"] = clock[0]
    clock[0] += 29
    assert hub._reopen_delay("c") == 60  # that open lasted 29 s: no reset
    hub._opened_at["c"] = clock[0]
    clock[0] += 30
    assert hub._reopen_delay("c") == 2  # lasted 30 s: back to the start


def test_ships_as_an_optional_user_plugin_not_a_bundled_one(tmp_path, monkeypatch):
    """Bundled dashboard plugins mount on every profile unless disabled; this one must be opt-in per profile."""
    from hermes_cli import web_server_dashboard as dashboard

    # The manifest, not the folder: an ignored __pycache__ left by an older checkout must not fail this.
    assert not (REPO / "plugins" / "computer-use" / "dashboard" / "manifest.json").exists()
    assert (PLUGIN_DIR / "dashboard" / "manifest.json").is_file()
    monkeypatch.delenv("HERMES_BUNDLED_PLUGINS", raising=False)
    monkeypatch.delenv("HERMES_ENABLE_PROJECT_PLUGINS", raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    found = {p["name"]: p for p in dashboard._discover_dashboard_plugins()}
    assert "computer-use" not in found
    assert found, "positive control: the bundled scan does list other dashboard plugins"

    # Installed as the README says, it is a user plugin, mounted only once in plugins.enabled.
    shutil.copytree(PLUGIN_DIR, tmp_path / "plugins" / "computer-use")
    entry = {p["name"]: p for p in dashboard._discover_dashboard_plugins()}["computer-use"]
    assert entry["source"] == "user"
    assert dashboard._plugin_api_mount_skip_reason(entry, set(), set()) == "not in plugins.enabled"
    assert dashboard._plugin_api_mount_skip_reason(entry, {"computer-use"}, set()) is None


# --- pilot fix round 2 ------------------------------------------------------------------------------


def test_available_answers_200_with_the_plugin_mounted_and_nothing_else():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/computer-use")
    client = TestClient(app)
    response = client.get("/api/plugins/computer-use/available")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "plugin": "computer-use"}
    # Negative control: a profile without the plugin mounted has no such route.
    assert TestClient(FastAPI()).get("/api/plugins/computer-use/available").status_code == 404


def test_reopen_attempts_never_overflow(home):
    hub = api.Hub(home)
    hub._reopen_attempts["c"] = 5000  # 2.0 * 2 ** 1024 raised OverflowError before the cap
    assert hub._reopen_delay("c") == 60
    assert hub._reopen_attempts["c"] <= api.REOPEN_ATTEMPTS_CAP + 1
    for _ in range(2000):
        assert hub._reopen_delay("c") == 60
