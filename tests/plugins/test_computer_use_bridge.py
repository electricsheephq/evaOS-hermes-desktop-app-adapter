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

PLUGIN_DIR = Path(__file__).resolve().parents[2] / "plugins" / "computer-use"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


api = _load("computer_use_plugin_api", PLUGIN_DIR / "dashboard" / "plugin_api.py")
shim_mod = _load("computer_use_shim", PLUGIN_DIR / "mcp_stdio_shim.py")

OFFLINE = "Your Mac isn't connected. Ask the user to open evaOS Agent and turn on Computer Use (left sidebar)."


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
        await hub.attach_mac(second)
        assert first.closed == (4000, "replaced by a newer connection")
        assert hub.mac is second and not hub.ready
        await _until(lambda: {"t": "offline"} in client.frames)
        # The old connection's late frames are ignored; the new Mac gets the shim once it says hello.
        await hub.on_mac_frame(first, {"t": "msg", "c": first.of("open")[0]["c"], "m": {"id": 1, "result": {}}})
        await hub.on_mac_frame(second, HELLO)
        await _until(lambda: second.of("open"))
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
    assert by_id[9]["result"]["content"][0]["text"] == OFFLINE and by_id[9]["result"]["isError"] is True
    assert by_id[10]["error"]["code"] == -32601
    shim.from_hermes({"jsonrpc": "2.0", "id": 11, "method": "tools/call", "params": {"name": "click"}})
    assert len(shim.sock.lines) == 2  # offline now: nothing more goes up


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
    assert [r.path for r in api.router.routes] == ["/bridge"]
