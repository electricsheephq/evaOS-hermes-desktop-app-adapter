"""es.9 wire fixture against the r34 server, keyed off the pinned es.9 session-bind protocol contract.

es.9 Desktop stamps ``desktop_ui_protocol`` on every session.create / session.resume / session.activate.
The level and the method set come from ``tests/tui_gateway/contracts/es9_protocol.json`` (recorded once from
the es.9 tag and the r33.6 predecessor, which agree), and the call-site keys from the audited es.9 inventory
(``tests/tui_gateway/contracts/es9_rpc_shapes.json``); the test reads that data only, never TypeScript.
An es.9 client (never advertises server→client requests) binds a session with every one of those keys,
the agent asks a clarify question mid-turn, the client resumes and re-activates, and answers with the
legacy ``clarify.respond``. RED/GREEN pair: with the legacy prompt shim the turn completes; with
``HERMES_EVAOS_LEGACY_PROMPT_SHIM=0`` the binds still succeed but there is no legacy twin, no
``pending_clarify`` on reconnect, the legacy answer is an unknown method and the clarify times out. (The raw
upstream tag additionally refuses the ``desktop_ui_protocol`` bind key with ``4000``; that control is a
receipt, not this test.)
"""

from __future__ import annotations

import asyncio
import itertools
import json
import threading
import time

import pytest

from tests.r34_compat import _pair as pair
from tui_gateway import server
from tui_gateway import server_requests
from tui_gateway.contracts import registry as contracts
from tui_gateway.ws import WSTransport

SHIM_ENV = "HERMES_EVAOS_LEGACY_PROMPT_SHIM"
CONTRACTS = pair.CURRENT_ROOT / "tests" / "tui_gateway" / "contracts"
SHAPES = CONTRACTS / "es9_rpc_shapes.json"
PROTOCOL = CONTRACTS / "es9_protocol.json"
REPLY_TIMEOUT = 10.0

_LOOP = asyncio.new_event_loop()
threading.Thread(target=_LOOP.run_forever, daemon=True).start()


class _Es9(WSTransport):
    """A WebSocket client that records frames and never advertises server→client requests."""

    def __init__(self):
        super().__init__(object(), _LOOP, peer="r34-es9-fixture")
        self.frames: list[dict] = []
        self.sent_ids: list[str] = []
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


def _inventory(methods: set[str]) -> dict[str, list[dict[str, object]]]:
    """method -> every recorded es.9 call-site shape of that method."""
    shapes: dict[str, list[dict[str, object]]] = {method: [] for method in methods}
    for shape in json.loads(SHAPES.read_text(encoding="utf-8"))["shapes"]:
        if shape["method"] in methods:
            shapes[shape["method"]].append(dict(shape["params"]))
    assert all(shapes.values()), shapes
    return shapes


@pytest.fixture
def es9_binds():
    protocol = json.loads(PROTOCOL.read_text(encoding="utf-8"))
    assert protocol["recorded_from"]["predecessor_runtime_commit"] == pair.PREDECESSOR_COMMIT, (
        "predecessor pin moved: re-record es9_protocol.json from the new pair")
    methods = set(protocol["methods"])
    assert methods == {"session.create", "session.resume", "session.activate"}
    return protocol["desktop_ui_protocol"], _inventory(methods)


def test_every_es9_session_bind_key_is_accepted_by_the_r34_contracts(es9_binds):
    level, inventory = es9_binds
    for method, shapes in inventory.items():
        union: dict[str, object] = {}
        for shape in shapes:
            assert shape.get("desktop_ui_protocol") == level, method
            union.update(shape)
        _, problem = contracts.validate_params(contracts.METHODS[method], union)
        assert problem is None, (method, problem)


_RPC_IDS = itertools.count(1)


def _rpc(peer, method, params, *, rid=None, timeout=REPLY_TIMEOUT):
    """Dispatch one request under an id never sent on ``peer`` and return ITS reply: a pooled handler
    answers on the transport, so only frames written after this dispatch are scanned."""
    rid = rid or f"r34-{method}-{next(_RPC_IDS)}"
    assert rid not in peer.sent_ids, f"RPC id {rid} reused on this transport"
    peer.sent_ids.append(rid)
    with peer._frames_lock:
        cursor = len(peer.frames)
    reply = server.dispatch({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}, peer)
    deadline = time.monotonic() + timeout
    while reply is None and time.monotonic() < deadline:
        with peer._frames_lock:
            reply = next((f for f in peer.frames[cursor:] if f.get("id") == rid), None)
        if reply is None:
            time.sleep(0.01)
    assert reply is not None, f"{method} ({rid}) never answered within {timeout}s"
    return reply


def _bind(peer, live, method, params):
    """A bind whose session id joins ``live`` (cleanup) before the next call is made."""
    reply = _rpc(peer, method, params)
    bound = (reply.get("result") or {}).get("session_id")
    if bound and bound not in live:
        live.append(bound)
    return reply


def test_rpc_helper_pairs_each_request_with_its_own_reply(monkeypatch):
    """A stale frame carrying the id is ignored, a reused id is refused, a missing reply fails."""
    peer = _Es9()
    peer.frames.append({"jsonrpc": "2.0", "id": "r34-probe", "result": {"stale": True}})

    def pooled(request, transport):  # answers later, on the transport, like a pooled handler
        threading.Timer(0.05, transport.write, [{"jsonrpc": "2.0", "id": request["id"],
                                                  "result": {"fresh": True}}]).start()
        return None

    monkeypatch.setattr(server, "dispatch", pooled)
    assert _rpc(peer, "session.resume", {}, rid="r34-probe")["result"] == {"fresh": True}
    with pytest.raises(AssertionError, match="reused"):
        _rpc(peer, "session.resume", {}, rid="r34-probe")
    monkeypatch.setattr(server, "dispatch", lambda request, transport: None)
    with pytest.raises(AssertionError, match="never answered"):
        _rpc(peer, "session.create", {}, timeout=0.2)


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
            reply = _bind(es9, live, "session.create", _fill(shape, level, **ids))
            assert "error" not in reply, (shape, reply)
            created.append(reply)
        sid, stored = created[0]["result"]["session_id"], created[0]["result"]["stored_session_id"]
        clarify = server._agent_cbs(sid)["clarify_callback"]
        thread = threading.Thread(target=lambda: box.__setitem__("r", clarify("Deploy now?", ["yes", "no"])),
                                  daemon=True)
        thread.start()
        deadline = time.monotonic() + 5
        while not es9.events("clarify.request") and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.01)
        twins = es9.events("clarify.request")
        resumed = [_bind(es9, live, "session.resume", _fill(shape, level, session_id=stored))
                   for shape in inventory["session.resume"]]
        activated = [_bind(es9, live, "session.activate", _fill(shape, level, session_id=sid))
                     for shape in inventory["session.activate"]]
        answered = _rpc(es9, "clarify.respond", {"request_id": twins[0]["request_id"] if twins else "srq-none",
                                                 "answer": "yes"})
        thread.join(timeout=10)
        assert len(set(es9.sent_ids)) == len(es9.sent_ids), es9.sent_ids
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


def test_es9_binds_with_the_shim_off_get_no_twin_no_pending_clarify_and_the_clarify_times_out(
        monkeypatch, tmp_path, es9_binds):
    """Kill switch: binds still succeed (unlike the raw tag, which refuses ``desktop_ui_protocol`` with
    ``4000``), but the legacy twin, ``pending_clarify`` and ``clarify.respond`` (-32601) are gone."""
    from tools.clarify_tool import TIMEOUT_RESPONSE

    monkeypatch.setenv(SHIM_ENV, "0")
    turn = _es9_turn(monkeypatch, tmp_path, *es9_binds)
    assert turn["twins"] == []
    for reply in turn["resumed"] + turn["activated"]:
        assert "error" not in reply, reply  # binding is not the shim's job; the prompt path is
        assert "pending_clarify" not in reply["result"], reply
    assert turn["answered"]["error"]["code"] == -32601
    assert turn["result"] == TIMEOUT_RESPONSE
