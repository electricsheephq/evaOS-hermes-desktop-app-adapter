"""es.9 wire fixture against the r34 server, keyed off the PREDECESSOR Desktop source.

The predecessor's ``apps/desktop/src/api/client.ts`` stamps ``desktop_ui_protocol`` on every
session.create / session.resume / session.activate (``withDesktopUiProtocol``); the value and the method
set are read from that file, and the call-site keys from the audited es.9 inventory
(``tests/tui_gateway/contracts/es9_rpc_shapes.json``), whose sites are checked against the same tree.
An es.9 client (never advertises server→client requests) binds a session with every one of those keys,
the agent asks a clarify question mid-turn, the client resumes and re-activates, and answers with the
legacy ``clarify.respond``. RED/GREEN pair: with the legacy prompt shim the turn completes; with
``HERMES_EVAOS_LEGACY_PROMPT_SHIM=0`` it fails exactly as the raw upstream tag does (no legacy twin,
the legacy answer is an unknown method, the clarify times out, no ``pending_clarify`` on reconnect).
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
import re
import threading
import time

import pytest

from tests.r34_compat import _pair as pair
from tui_gateway import server
from tui_gateway import server_requests
from tui_gateway.contracts import registry as contracts
from tui_gateway.ws import WSTransport

SHIM_ENV = "HERMES_EVAOS_LEGACY_PROMPT_SHIM"
CLIENT_TS = Path("apps/desktop/src/api/client.ts")
SHAPES = pair.CURRENT_ROOT / "tests" / "tui_gateway" / "contracts" / "es9_rpc_shapes.json"

_LOOP = asyncio.new_event_loop()
threading.Thread(target=_LOOP.run_forever, daemon=True).start()


class _Es9(WSTransport):
    """A WebSocket client that records frames and never advertises server→client requests."""

    def __init__(self):
        super().__init__(object(), _LOOP, peer="r34-es9-fixture")
        self.frames: list[dict] = []
        self._frames_lock = threading.Lock()

    def write(self, obj):
        with self._frames_lock:
            self.frames.append(json.loads(json.dumps(obj)))
        return True

    async def write_async(self, obj):
        return self.write(obj)

    def close(self):
        self._closed = True

    def events(self, kind: str) -> list[dict]:
        with self._frames_lock:
            return [f["params"]["payload"] for f in self.frames
                    if f.get("method") == "event" and f.get("params", {}).get("type") == kind]


def _predecessor_marker(root: Path) -> tuple[int, set[str]]:
    source = (root / CLIENT_TS).read_text(encoding="utf-8")
    level = re.search(r"export const DESKTOP_UI_PROTOCOL = (\d+)\b", source)
    methods = re.search(r"const DESKTOP_UI_PROTOCOL_METHODS = new Set\(\[([^\]]*)\]\)", source)
    assert level and methods, "predecessor client.ts no longer declares the protocol marker"
    assert "withDesktopUiProtocol(method, params)" in source
    return int(level.group(1)), set(re.findall(r"'([^']+)'", methods.group(1)))


def _inventory(root: Path, methods: set[str]) -> dict[str, list[dict[str, object]]]:
    """method -> every recorded es.9 call-site shape of that method (sites checked against ``root``)."""
    shapes: dict[str, list[dict[str, object]]] = {method: [] for method in methods}
    for shape in json.loads(SHAPES.read_text(encoding="utf-8"))["shapes"]:
        if shape["method"] not in methods:
            continue
        site = root / shape["site"].rsplit(":", 1)[0]
        assert site.is_file() and f"'{shape['method']}'" in site.read_text(encoding="utf-8"), shape["site"]
        shapes[shape["method"]].append(dict(shape["params"]))
    assert all(shapes.values()), shapes
    return shapes


@pytest.fixture
def es9_binds(request: pytest.FixtureRequest):
    root = pair.predecessor_root(request.config)
    level, methods = _predecessor_marker(root)
    assert methods == {"session.create", "session.resume", "session.activate"}
    return level, _inventory(root, methods)


def test_every_predecessor_session_bind_key_is_accepted_by_the_r34_contracts(es9_binds):
    level, inventory = es9_binds
    for method, shapes in inventory.items():
        union: dict[str, object] = {}
        for shape in shapes:
            assert shape.get("desktop_ui_protocol") == level, method
            union.update(shape)
        _, problem = contracts.validate_params(contracts.METHODS[method], union)
        assert problem is None, (method, problem)


def _rpc(peer, method, params):
    rid = f"r34-{method}"
    reply = server.dispatch({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}, peer)
    deadline = time.monotonic() + 10
    while reply is None and time.monotonic() < deadline:  # a pooled handler answers on the transport
        with peer._frames_lock:
            reply = next((f for f in peer.frames if f.get("id") == rid), None)
        time.sleep(0.01)
    assert reply is not None, f"{method} never answered"
    return reply


# Real values for the inventory's ``'x'`` placeholders; recorded booleans and numbers are sent as recorded.
_VALUES = {"profile": "default", "title": "r34 es.9 wire fixture", "model": "z-ai/glm-5.2",
           "provider": "openrouter", "reasoning_effort": "medium"}


def _fill(shape: dict[str, object], level: int, **ids: str) -> dict[str, object]:
    params: dict[str, object] = {}
    for key, value in shape.items():
        if key in ids:
            value = ids[key]
        elif key == "desktop_ui_protocol":
            value = level
        elif key == "messages":
            value = [{**message, "content": "r34 es.9 seed"} for message in value]
        elif value == "x":
            value = _VALUES[key]
        params[key] = value
    return params


def _es9_turn(monkeypatch, tmp_path, level, inventory):
    """Every recorded create shape binds; the first hosts a clarify turn; every resume shape and the
    activate shape rebind it mid-prompt; the legacy answer settles it."""
    monkeypatch.setattr(server, "_schedule_agent_build", lambda _sid: None)
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda: None)
    _VALUES["cwd"] = str(tmp_path)
    es9 = _Es9()
    live: list[str] = []
    box: dict = {}
    try:
        created = []
        # The branch shape (``parent_session_id``) needs a stored parent: bind it last.
        for shape in sorted(inventory["session.create"], key=lambda shape: "parent_session_id" in shape):
            ids = {"parent_session_id": created[0]["result"]["stored_session_id"]} if created else {}
            reply = _rpc(es9, "session.create", _fill(shape, level, **ids))
            assert "error" not in reply, (shape, reply)
            live.append(reply["result"]["session_id"])
            created.append(reply)
        sid, stored = live[0], created[0]["result"]["stored_session_id"]
        clarify = server._agent_cbs(sid)["clarify_callback"]
        thread = threading.Thread(target=lambda: box.__setitem__("r", clarify("Deploy now?", ["yes", "no"])),
                                  daemon=True)
        thread.start()
        deadline = time.monotonic() + 5
        while not es9.events("clarify.request") and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.01)
        twins = es9.events("clarify.request")
        resumed = [_rpc(es9, "session.resume", _fill(shape, level, session_id=stored))
                   for shape in inventory["session.resume"]]
        activated = [_rpc(es9, "session.activate", _fill(shape, level, session_id=sid))
                     for shape in inventory["session.activate"]]
        answered = _rpc(es9, "clarify.respond", {"request_id": twins[0]["request_id"] if twins else "srq-none",
                                                 "answer": "yes"})
        thread.join(timeout=10)
        return {"twins": twins, "resumed": resumed, "activated": activated, "answered": answered,
                "result": box.get("r")}
    finally:
        for live_sid in live:
            server._close_session_by_id(live_sid, end_reason="test_cleanup")
        server_requests.cancel(None, reason="shutdown")
        server_requests.reset_for_tests()


def test_es9_binds_and_answers_a_clarify_with_the_shim(monkeypatch, tmp_path, es9_binds):
    monkeypatch.setenv(SHIM_ENV, "1")
    turn = _es9_turn(monkeypatch, tmp_path, *es9_binds)
    assert turn["twins"] and turn["twins"][0]["question"] == "Deploy now?", turn["twins"]
    for reply in turn["resumed"] + turn["activated"]:
        assert "error" not in reply, reply
        assert reply["result"].get("pending_clarify") == turn["twins"][0], reply
    assert turn["answered"].get("result") == {"status": "ok"}, turn["answered"]
    assert turn["result"] == "yes"


def test_es9_binds_with_the_kill_switch_fail_as_the_raw_tag(monkeypatch, tmp_path, es9_binds):
    from tools.clarify_tool import TIMEOUT_RESPONSE

    monkeypatch.setenv(SHIM_ENV, "0")
    turn = _es9_turn(monkeypatch, tmp_path, *es9_binds)
    assert turn["twins"] == []
    for reply in turn["resumed"] + turn["activated"]:
        assert "error" not in reply, reply  # binding is not the shim's job; the prompt path is
        assert "pending_clarify" not in reply["result"], reply
    assert turn["answered"]["error"]["code"] == -32601
    assert turn["result"] == TIMEOUT_RESPONSE
