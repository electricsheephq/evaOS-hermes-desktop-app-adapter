"""evaOS (r34, EVAOS-LEGACY-PROMPT-SHIM; rs35: delete with ``tui_gateway/legacy_prompt_shim.py``).

A pre-es.10 Desktop (es.9) never sends ``client.capabilities`` and drops ``srq-…`` frames: it listens for
``<kind>.request`` / ``<kind>.expire`` events, answers with ``<kind>.respond``, restores a clarify card from
``pending_clarify``, and names the session as ``{session_id}`` on ``connectors.list`` / ``.connect``. The shim
keeps that client working on the r34 runtime; ``HERMES_EVAOS_LEGACY_PROMPT_SHIM=0`` restores the raw tag.
"""

import asyncio
import json
import os
import threading
import time
from contextlib import ExitStack, suppress

import pytest

from tui_gateway import server
from tui_gateway import server_requests
from tui_gateway.contracts.sessions import LiveSessionSnapshot
from tui_gateway.transport import FanoutTransport, StdioTransport, bind_transport, reset_transport
from tui_gateway.ws import WSTransport

ENV = "HERMES_EVAOS_LEGACY_PROMPT_SHIM"
QUESTIONS = [{"qid": q, "id": "", "question": q, "choices": None, "choices_offered": [], "multi_select": False}
             for q in ("q0", "q1")]


_LOOP = asyncio.new_event_loop()
threading.Thread(target=_LOOP.run_forever, daemon=True).start()


class _Peer(WSTransport):
    """A WebSocket client that records frames. es.9 unless it advertises server→client requests."""

    def __init__(self, *, advertised=False):
        super().__init__(object(), _LOOP, peer="test")
        self.frames: list[dict] = []
        self._lock_frames = threading.Lock()
        if advertised:
            server_requests.advertise(self, True)

    def write(self, obj):
        with self._lock_frames:
            self.frames.append(json.loads(json.dumps(obj)))
        return True

    async def write_async(self, obj):  # the session fanout's per-peer writer awaits this
        return self.write(obj)

    def close(self):
        self._closed = True

    def kinds(self):
        with self._lock_frames:
            return [f["params"]["type"] if f.get("method") == "event" else f.get("method") for f in self.frames]

    def wait(self, count):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            with self._lock_frames:
                if len(self.frames) >= count:
                    return list(self.frames)
            time.sleep(0.01)
        raise AssertionError(f"expected {count} frames, got {self.kinds()}")


@pytest.fixture(autouse=True)
def _shim_on(monkeypatch):
    monkeypatch.setenv(ENV, "1")
    yield
    server_requests.cancel(None, reason="shutdown")
    server_requests.reset_for_tests()


def _session(monkeypatch, sid, transport, **extra):
    session = {"session_key": sid, "transport": transport, "history": [], "history_lock": threading.Lock(),
               "agent_ready": None, **extra}
    monkeypatch.setitem(server._sessions, sid, session)
    return session


def _bg(fn):
    box: dict = {}
    thread = threading.Thread(target=lambda: box.__setitem__("r", fn()), daemon=True)
    thread.start()
    return thread, box


def _open_request(sid):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        with server_requests._lock:
            req = next((r for r in server_requests._open.values() if r.sid == sid), None)
        if req is not None:
            return req
        time.sleep(0.01)
    raise AssertionError("server request never registered")


def _rpc(peer, method, **params):
    return server.dispatch({"jsonrpc": "2.0", "id": "r1", "method": method, "params": params}, peer)


# ── legacy prompts ────────────────────────────────────────────────────────────────────────────


def test_legacy_clarify_single_answers_the_same_request_first_answer_wins(monkeypatch):
    old = _Peer()
    _session(monkeypatch, "ws-old", old)
    thread, box = _bg(lambda: server._clarify_block("ws-old", "Pick?", ["a", "b"]))
    req = _open_request("ws-old")
    srq, twin = old.wait(2)
    assert srq["id"] == req.id and srq["method"] == "clarify"
    assert twin["params"]["type"] == "clarify.request"
    assert twin["params"]["payload"] == {"question": "Pick?", "choices": ["a", "b"], "request_id": req.id}

    assert _rpc(old, "clarify.respond", request_id=req.id, answer="b")["result"] == {"status": "ok"}
    thread.join(timeout=5)
    assert box["r"] == "b"
    assert _rpc(old, "clarify.respond", request_id=req.id, answer="a")["result"] == {"status": "expired"}
    assert not server_requests._open


def test_legacy_clarify_batch_locks_per_question_and_restores_from_pending_clarify(monkeypatch):
    old = _Peer()
    session = _session(monkeypatch, "ws-old", old)
    thread, box = _bg(lambda: server._clarify_block("ws-old", "", None, questions=QUESTIONS))
    req = _open_request("ws-old")
    twin = old.wait(2)[1]["params"]["payload"]
    assert [q["qid"] for q in twin["questions"]] == ["q0", "q1"] and twin["request_id"] == req.id

    assert _rpc(old, "clarify.respond", request_id=req.id, question_id="q0", answer="x")["result"] == {
        "status": "ok", "remaining": ["q1"]}
    assert _rpc(old, "clarify.respond", request_id=req.id, question_id="nope", answer="")["error"]["code"] == 4002
    # Reconnect: the snapshot carries the locked answer, in the shape es.9 restores its card from.
    snapshot = server._legacy_prompt_snapshot("ws-old", session)
    assert snapshot["request_id"] == req.id and snapshot["answers"] == {"q0": "x"}
    assert "session_id" not in snapshot
    LiveSessionSnapshot.model_validate({"session_id": "ws-old", "message_count": 0, "messages": [],
                                        "info": {}, "pending_clarify": snapshot})

    assert _rpc(old, "clarify.respond", request_id=req.id, question_id="q1", answer="y")["result"] == {
        "status": "ok", "remaining": []}
    thread.join(timeout=5)
    assert json.loads(box["r"])["answers"] == {"q0": "x", "q1": "y"}


def test_legacy_clarify_batch_respond_without_question_id_is_cancel_all(monkeypatch):
    old = _Peer()
    _session(monkeypatch, "ws-old", old)
    thread, box = _bg(lambda: server._clarify_block("ws-old", "", None, questions=QUESTIONS))
    req = _open_request("ws-old")
    assert _rpc(old, "clarify.respond", request_id=req.id, answer="")["result"] == {"status": "ok"}
    thread.join(timeout=5)
    assert box["r"] == ""


def test_new_client_gets_no_twin_and_kill_switch_restores_the_raw_tag(monkeypatch):
    new = _Peer(advertised=True)
    _session(monkeypatch, "ws-new", new)
    thread, box = _bg(lambda: server._ask("sudo", "ws-new", {}, timeout=5))
    req = _open_request("ws-new")
    assert new.wait(1)[0]["id"] == req.id
    assert server.dispatch({"jsonrpc": "2.0", "id": req.id, "result": {"value": "pw"}}, new) is None
    thread.join(timeout=5)
    assert box["r"] == "pw" and new.kinds() == ["sudo"]

    monkeypatch.setenv(ENV, "0")
    old = _Peer()
    _session(monkeypatch, "ws-old", old)
    t0 = time.monotonic()
    assert server._ask("sudo", "ws-old", {}, timeout=5) == ""
    assert time.monotonic() - t0 < 2 and old.frames == []
    assert _rpc(old, "sudo.respond", request_id="srq-x", password="pw")["error"]["code"] == -32601


def test_kill_switch_stops_the_twin_and_expire_on_a_mixed_session(monkeypatch):
    """shim=0 with an es.10 peer attached: the request still goes out (answerable), but es.9 gets no twin/expire."""
    monkeypatch.setenv(ENV, "0")
    old, new = _Peer(), _Peer(advertised=True)
    _session(monkeypatch, "mixed", FanoutTransport(old, new))
    assert server._ask("sudo", "mixed", {}, timeout=0.05) == ""
    for peer in (old, new):
        peer.wait(2)
        time.sleep(0.2)  # the fanout drains per peer: a late twin/expire would land here
        assert peer.kinds() == ["sudo", "request.cancel"], peer.kinds()


def test_kill_switch_drops_pending_clarify_from_activate(monkeypatch):
    """shim=0 with a clarify open (es.10 client, so it waits): activate carries open_requests, no pending_clarify."""
    monkeypatch.setenv(ENV, "0")
    monkeypatch.setattr(server, "_schedule_agent_build", lambda _sid: None)
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda: None)
    new = _Peer(advertised=True)
    sid = _rpc(new, "session.create", source="desktop", desktop_ui_protocol=3)["result"]["session_id"]
    try:
        thread, box = _bg(lambda: server._agent_cbs(sid)["clarify_callback"]("Deploy now?", ["yes", "no"]))
        req = _open_request(sid)
        activated = _rpc(new, "session.activate", session_id=sid, desktop_ui_protocol=3, omit_messages=True)
        assert [entry["id"] for entry in activated["result"]["open_requests"]] == [req.id]
        assert "pending_clarify" not in activated["result"]
        assert server.dispatch({"jsonrpc": "2.0", "id": req.id, "result": {"answer": "yes"}}, new) is None
        thread.join(timeout=5)
        assert box["r"] == "yes"
    finally:
        server._close_session_by_id(sid, end_reason="test_cleanup")


def test_mixed_peers_both_see_request_then_twin_and_first_answer_wins(monkeypatch):
    old, new = _Peer(), _Peer(advertised=True)
    _session(monkeypatch, "mixed", FanoutTransport(old, new))

    thread, box = _bg(lambda: server._ask("secret", "mixed", {"env_var": "K", "prompt": "key?"}, timeout=5))
    req = _open_request("mixed")
    for peer in (old, new):
        assert [f.get("id") or f["params"]["type"] for f in peer.wait(2)] == [req.id, "secret.request"]
    assert _rpc(old, "secret.respond", request_id=req.id, value="v1")["result"] == {"status": "ok"}
    thread.join(timeout=5)
    assert box["r"] == "v1"
    assert server.dispatch({"jsonrpc": "2.0", "id": req.id, "result": {"value": "late"}}, new) is None

    thread, box = _bg(lambda: server._ask("secret", "mixed", {"env_var": "K", "prompt": "key?"}, timeout=5))
    req = _open_request("mixed")
    old.wait(4)
    assert server.dispatch({"jsonrpc": "2.0", "id": req.id, "result": {"value": "v2"}}, new) is None
    thread.join(timeout=5)
    assert box["r"] == "v2"
    assert _rpc(old, "secret.respond", request_id=req.id, value="late")["result"] == {"status": "expired"}


def test_timeout_and_interrupt_expire_the_legacy_card(monkeypatch):
    old = _Peer()
    _session(monkeypatch, "ws-old", old)
    assert server._ask("sudo", "ws-old", {}, timeout=0.05) == ""
    srq, twin, cancel, expire = old.wait(4)
    assert (twin["params"]["type"], cancel["params"]["type"]) == ("sudo.request", "request.cancel")
    assert cancel["params"]["payload"]["reason"] == "timeout"
    assert expire["params"]["type"] == "sudo.expire" and expire["params"]["payload"] == {"request_id": srq["id"]}
    assert _rpc(old, "sudo.respond", request_id=srq["id"], password="late")["result"] == {"status": "expired"}

    old.frames.clear()
    monkeypatch.setattr(server, "_clarify_timeout_seconds", lambda: 0.05)
    thread, box = _bg(lambda: server._clarify_block("ws-old", "", None, questions=QUESTIONS))
    req = _open_request("ws-old")
    _rpc(old, "clarify.respond", request_id=req.id, question_id="q0", answer="x")
    thread.join(timeout=5)
    assert json.loads(box["r"]) == {"answers": {"q0": "x"}, "timed_out": True}
    assert old.kinds()[-2:] == ["request.cancel", "clarify.expire"]

    old.frames.clear()
    thread, box = _bg(lambda: server._ask("secret", "ws-old", {"env_var": "K", "prompt": "p"}, timeout=5))
    req = _open_request("ws-old")
    old.wait(2)
    server_requests.cancel("ws-old")
    thread.join(timeout=5)
    assert old.kinds() == ["secret", "secret.request", "request.cancel", "secret.expire"]
    assert old.frames[2]["params"]["payload"]["reason"] == "interrupted"


def test_legacy_approval_uses_the_queue_request_id_and_native_respond(monkeypatch):
    from tools import approval as approval_mod
    from tools import approval_gateway_wait as wait_mod

    old = _Peer()
    _session(monkeypatch, "ws-old-approval", old)
    monkeypatch.setattr(wait_mod._ctx, "_get_approval_timeout", lambda: 10)
    monkeypatch.setattr(wait_mod._ctx, "_fire_approval_hook", lambda name, **kw: None)
    approval_mod.register_gateway_notify("ws-old-approval",
                                         lambda data: server._emit_approval_request("ws-old-approval", data))
    try:
        thread, box = _bg(lambda: wait_mod._await_gateway_decision(
            "ws-old-approval", approval_mod._gateway_notify_cbs["ws-old-approval"],
            {"command": "rm -rf build", "description": "", "pattern_key": "dangerous",
             "pattern_keys": ["dangerous"]}))
        srq, twin = old.wait(2)
        assert srq["method"] == "approval" and twin["params"]["type"] == "approval.request"
        queue_id = twin["params"]["payload"]["request_id"]
        assert queue_id == srq["params"]["request_id"] and queue_id != srq["id"]
        assert "ws-old-approval" in approval_mod._gateway_queues  # not withdrawn: es.9 can answer
        response = _rpc(old, "approval.respond", session_id="ws-old-approval", request_id=queue_id, choice="once")
        assert "error" not in response, response
        thread.join(timeout=5)
    finally:
        approval_mod.unregister_gateway_notify("ws-old-approval")
    assert box["r"]["choice"] == "once"
    assert "approval.expire" not in old.kinds()


@pytest.mark.parametrize("method, params, respond, key, answer", [
    ("sudo", {}, "sudo.respond", "password", "pw"),
    ("secret", {"env_var": "K", "prompt": "p"}, "secret.respond", "value", "v"),
    ("vault.unlock_prompt", {"backend": "b", "display_name": "B"}, "vault.unlock.respond", "password", "pw"),
    ("vault.save_login", {"origin": "https://a", "site": "a"}, "vault.save_login.respond", "login",
     '{"identifier": "i", "password": "p"}'),
    ("vault.code", {"site": "a", "hint": ""}, "vault.code.respond", "code", "123456"),
])
def test_one_string_prompts_wait_for_the_legacy_answer(monkeypatch, method, params, respond, key, answer):
    old = _Peer()
    _session(monkeypatch, "ws-old", old)
    thread, box = _bg(lambda: server._ask(method, "ws-old", dict(params), timeout=5))
    req = _open_request("ws-old")
    twin = old.wait(2)[1]["params"]
    assert twin["type"] == f"{respond.removesuffix('.respond')}.request"
    assert twin["payload"] == {**params, "request_id": req.id}
    time.sleep(0.3)
    assert thread.is_alive()  # waiting, not failed fast
    assert _rpc(old, respond, request_id=req.id, **{key: answer})["result"] == {"status": "ok"}
    thread.join(timeout=5)
    assert box["r"] == answer


def test_legacy_respond_without_request_id_is_the_legacy_4009():
    response = server.handle_request({"id": 1, "method": "sudo.respond", "params": {"password": "pw"}})
    assert response["error"]["code"] == 4009
    assert "no pending password request" in response["error"]["message"]


def test_tour_twin_is_answered_by_tour_respond(monkeypatch):
    old = _Peer()
    session = _session(monkeypatch, "ws-old", old)
    thread, box = _bg(lambda: server._tour_request("ws-old", {"action": "stop"}))
    req = _open_request("ws-old")
    assert old.wait(2)[1]["params"]["payload"] == {"action": "stop", "request_id": req.id}
    assert _rpc(old, "tour.respond", request_id=req.id, text='{"success": true}')["result"] == {"status": "ok"}
    thread.join(timeout=5)
    assert json.loads(box["r"]) == {"success": True} and session["tour_bridge"] == "answered"


def test_uncovered_kinds_still_fail_fast_for_a_legacy_client(monkeypatch):
    old = _Peer()
    _session(monkeypatch, "ws-old", old)
    t0 = time.monotonic()
    assert server._ask("terminal.read", "ws-old", {}, timeout=5) == ""
    assert time.monotonic() - t0 < 2 and old.frames == []


def test_sticky_twin_and_compute_host_mirror_snapshot(monkeypatch):
    sink = _Peer()
    session = _session(monkeypatch, "ws-gone", None)
    # es.9 read the session once (resume/activate), then detached: the snapshot marks it legacy.
    token = bind_transport(_Peer())
    try:
        assert server._legacy_prompt_snapshot("ws-gone", session) is None
    finally:
        reset_transport(token)
    assert session["_lp_seen"] is True
    session["transport"] = FanoutTransport()  # no live WS peer; the frames still reach the replay ring
    written = []
    monkeypatch.setattr(server, "_upstream_write_json", lambda obj: written.append(obj) or sink.write(obj))
    thread, _ = _bg(lambda: server._ask("sudo", "ws-gone", {}, timeout=0.2))
    thread.join(timeout=5)
    assert [f["params"]["type"] if f.get("method") == "event" else f["method"] for f in written] == [
        "sudo", "sudo.request", "request.cancel", "sudo.expire"]

    # Turn isolation: the child owns the request; the parent's mirror feeds pending_clarify.
    session["_compute_host_open_request"] = {"id": "srq-child", "method": "clarify",
                                             "params": {"session_id": "ws-gone", "question": "q?", "choices": None}}
    assert server._legacy_prompt_snapshot("ws-gone", session) == {"question": "q?", "choices": None,
                                                                  "request_id": "srq-child"}


def test_legacy_names_stay_out_of_the_catalog_and_never_shadow_a_real_handler(monkeypatch):
    assert not {"clarify.respond", "sudo.respond", "secret.respond", "tour.respond"} & set(server._methods)
    monkeypatch.setitem(server._methods, "clarify.respond", lambda rid, params: server._ok(rid, {"upstream": True}))
    assert server.handle_request({"id": 1, "method": "clarify.respond",
                                  "params": {"request_id": "srq-x", "answer": ""}})["result"] == {"upstream": True}


# ── es.9 wire fixture: session.create → a clarify turn → session.activate ────────────────────────


def _es9_turn(monkeypatch):
    """es.9 opens a Desktop session (its session.create adds ``desktop_ui_protocol: 3``), the agent asks a
    clarify question mid-turn, es.9 re-activates the session (reconnect) and answers with ``clarify.respond``."""
    monkeypatch.setattr(server, "_schedule_agent_build", lambda _sid: None)
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda: None)
    es9 = _Peer()
    created = _rpc(es9, "session.create", source="desktop", desktop_ui_protocol=3, cols=120)
    assert "error" not in created, created
    sid = created["result"]["session_id"]
    try:
        clarify = server._agent_cbs(sid)["clarify_callback"]
        thread, box = _bg(lambda: clarify("Deploy now?", ["yes", "no"]))
        deadline = time.monotonic() + 5
        while "clarify.request" not in es9.kinds() and thread.is_alive() and time.monotonic() < deadline:
            time.sleep(0.01)
        twins = [f["params"]["payload"] for f in es9.frames if f.get("params", {}).get("type") == "clarify.request"]
        activated = _rpc(es9, "session.activate", session_id=sid, desktop_ui_protocol=3, omit_messages=True)
        answered = _rpc(es9, "clarify.respond", request_id=twins[0]["request_id"] if twins else "srq-none",
                        answer="yes")
        thread.join(timeout=5)
        return box["r"], twins, activated, answered
    finally:
        server._close_session_by_id(sid, end_reason="test_cleanup")


def test_es9_wire_fixture_completes_a_clarify_turn(monkeypatch):
    result, twins, activated, answered = _es9_turn(monkeypatch)
    assert answered.get("result") == {"status": "ok"}, answered
    assert twins and twins[0]["question"] == "Deploy now?", twins
    assert activated["result"].get("pending_clarify") == twins[0], activated
    assert result == "yes"


def test_es9_wire_fixture_with_the_kill_switch_fails_as_the_raw_tag(monkeypatch):
    from tools.clarify_tool import TIMEOUT_RESPONSE

    monkeypatch.setenv(ENV, "0")
    result, twins, activated, answered = _es9_turn(monkeypatch)
    assert twins == [] and answered["error"]["code"] == -32601
    assert "pending_clarify" not in activated["result"]
    assert result == TIMEOUT_RESPONSE


# ── R13: es.9 connectors.list / connectors.connect send {session_id}; r34 takes owner ──────────


class _Owner:
    """A client on its own stdio-framed pipe (connector RPCs run on the pool and write their reply)."""

    def __init__(self, stack):
        read_fd, write_fd = os.pipe()
        reader = stack.enter_context(os.fdopen(read_fd, "r", encoding="utf-8"))
        writer = os.fdopen(write_fd, "w", encoding="utf-8")
        stack.callback(lambda: suppress(BrokenPipeError) and writer.close())
        self.transport = StdioTransport(lambda: writer, threading.Lock())
        self.frames: list[dict] = []
        threading.Thread(target=lambda: [self.frames.append(json.loads(line)) for line in reader], daemon=True).start()

    def call(self, method, params):
        before = len(self.frames)
        response = server.dispatch({"jsonrpc": "2.0", "id": 9, "method": method, "params": params}, self.transport)
        if response is not None:
            return response
        deadline = time.time() + 5
        while time.time() < deadline:
            replies = [f for f in list(self.frames)[before:] if f.get("id") == 9]
            if replies:
                return replies[-1]
            time.sleep(0.01)
        raise AssertionError("no reply")


SID = "legacy-connector-session"
ES9_LIST = {"session_id": SID, "profile": "default"}
NATIVE_LIST = {"owner": {"type": "session", "session_id": SID}, "profile": "default"}


@pytest.fixture
def owned_session(monkeypatch):
    from tools.connectors import live

    live.reset_for_tests()
    rows = [{"connector": "gmail", "enabled": True, "connected": False, "connection_status": None,
             "status_reason": None, "gateway_disabled_tools": []}]
    monkeypatch.setattr("tools.connectors.connectors_available", lambda: True)
    monkeypatch.setattr("model_tools._select_tool_names", lambda *a, **k: {"manage_connections"})
    monkeypatch.setattr("model_tools.handle_function_call",
                        lambda name, args, **kw: json.dumps({"connectors": rows}) if args["action"] == "status"
                        else json.dumps({"error": "unexpected"}))
    with ExitStack() as stack:
        owner, stranger = _Owner(stack), _Owner(stack)
        _session(monkeypatch, SID, owner.transport, agent=None, history_version=0, running=False,
                 attached_images=[], source="desktop")
        yield owner, stranger
    live.reset_for_tests()


def test_r13_es9_connector_shape_becomes_the_native_session_owner():
    """client shape → runtime shape: only the session id moves; a client ``owner`` is never rewritten."""
    assert server._legacy_connector_params("connectors.list", dict(ES9_LIST)) == NATIVE_LIST
    es9_connect = {"session_id": SID, "connectors": ["gmail"], "reconnect": False, "profile": "default"}
    assert server._legacy_connector_params("connectors.connect", es9_connect) == {
        "owner": {"type": "session", "session_id": SID}, "connectors": ["gmail"], "reconnect": False,
        "profile": "default"}
    forged = {"owner": {"type": "account"}, "session_id": SID}
    assert server._legacy_connector_params("connectors.list", forged) is forged
    assert server._legacy_connector_params("connectors.operation.status", dict(ES9_LIST)) == ES9_LIST


def test_r13_es9_connectors_list_answers_as_the_native_client_plus_connection_status(owned_session):
    """runtime shape → response: the native reply, each row also carrying es.9's camelCase ``connectionStatus``
    (PR-2b); authority is still the transport."""
    owner, stranger = owned_session
    native = owner.call("connectors.list", NATIVE_LIST)
    assert native["result"]["available"] is True and native["result"]["connectors"][0]["connector"] == "gmail"
    assert "connectionStatus" not in native["result"]["connectors"][0]  # native rows unchanged
    es9 = owner.call("connectors.list", ES9_LIST)
    assert es9["result"]["connectors"] == [{**row, "connectionStatus": row["connection_status"]}
                                           for row in native["result"]["connectors"]]
    assert {**es9, "result": {**es9["result"], "connectors": native["result"]["connectors"]}} == native
    refused = stranger.call("connectors.list", ES9_LIST)
    assert refused["error"]["code"] == 4001 and refused["error"]["data"]["reason"] == "NOT_OWNER"


def test_r13_es9_connectors_connect_reaches_the_native_session_path(owned_session):
    owner, _ = owned_session
    es9 = owner.call("connectors.connect", {"session_id": SID, "connectors": ["gmail"], "reconnect": False,
                                            "profile": "default"})
    native = owner.call("connectors.connect", {**NATIVE_LIST, "connectors": ["gmail"], "reconnect": False})
    assert es9 == native
    assert es9["error"]["data"]["reason"] == "UNKNOWN_OPERATION"  # r34: connect re-issues an open operation


def test_r13_kill_switch_rejects_the_es9_connector_shape_as_the_raw_tag(owned_session, monkeypatch):
    owner, _ = owned_session
    monkeypatch.setenv(ENV, "0")
    rejected = owner.call("connectors.list", ES9_LIST)
    assert rejected["error"]["code"] == 4000 and "session_id" in rejected["error"]["message"]


# ── PR-2b: the replies es.9 reads (connector-flow.ts:178-214, connector-tools.ts:9,123) ─────────────────


def _es9_connect_phase(reply, slug):
    """es.9's connector card as the #369 review quotes it: ``results[]`` → the entry with ``connector === slug``;
    ``active`` → refresh, ``initiated`` + ``connect_url`` → open the link, anything else or an RPC error → error."""
    entry = next((r for r in (reply.get("result") or {}).get("results") or [] if r.get("connector") == slug), None)
    if "error" in reply or entry is None:
        return ("error",)
    if entry.get("status") == "active":
        return ("refresh",)
    return ("open", entry["connect_url"]) if entry.get("status") == "initiated" and entry.get("connect_url") else ("error",)


@pytest.fixture
def connector_op(owned_session, monkeypatch):
    """An open operation on the es.9 session: gmail waits on a valid link, notion is connected, slack failed."""
    from tools.connectors import live
    from tools.connectors.contract import Actor, TargetState
    from tools.connectors.operation import ConnectionOperation, Target

    mints = []

    class Client:
        def connections(self, names, *, reinitiate=False, **_):
            mints.append(tuple(names))
            return {"results": [{"connector": n, "status": "initiated", "connect_url": f"https://l/{n}/2",
                                 "connection_id": f"acct-{n}"} for n in names]}

    monkeypatch.setattr("tools.connectors.gateway.client.ConnectorClient", Client)
    op = ConnectionOperation([Target(n, "connector", "connect") for n in ("gmail", "notion", "slack")], session_key=SID)
    live.open(op)
    for name in ("gmail", "notion", "slack"):
        op.transition(name, TargetState.initiated, Actor.backend_watcher, connect_url=f"https://l/{name}/1")
    op.transition("notion", TargetState.connected, Actor.backend_watcher, connection_id="acct-notion")
    op.transition("slack", TargetState.failed, Actor.backend_watcher, detail="vendor: nope")
    return owned_session, op, mints


ES9_CONNECT = {"session_id": SID, "reconnect": False, "profile": "default"}


def test_pr2b_es9_connect_on_a_still_valid_link_answers_the_results_es9_opens(connector_op):
    """The common case (the tool just minted, the target waits): r34 answers 4002 LINK_STILL_VALID; es.9 gets the
    r33 ``{results, summary}`` carrying the stored link instead, and nothing is re-minted."""
    (owner, _), _, mints = connector_op
    reply = owner.call("connectors.connect", {**ES9_CONNECT, "connectors": ["gmail"]})
    assert reply["result"] == {"summary": {}, "results": [
        {"connector": "gmail", "status": "initiated", "connect_url": "https://l/gmail/1"},
        {"connector": "notion", "status": "active", "connect_url": "https://l/notion/1"},
        # The spec's mapping (not connected → initiated); es.9 reads only the slug it asked for, and a dead link
        # it asks for is re-minted first (next test).
        {"connector": "slack", "status": "initiated", "connect_url": "https://l/slack/1"}]}
    assert _es9_connect_phase(reply, "gmail") == ("open", "https://l/gmail/1")
    assert _es9_connect_phase(reply, "notion") == ("refresh",)
    assert mints == []


def test_pr2b_es9_connect_reissue_answers_the_operation_view_as_results(connector_op):
    (owner, _), op, mints = connector_op
    reply = owner.call("connectors.connect", {**ES9_CONNECT, "connectors": ["slack"]})
    assert mints == [("slack",)]
    assert set(reply) == {"jsonrpc", "id", "result"} and set(reply["result"]) == {"results", "summary"}
    assert _es9_connect_phase(reply, "slack") == ("open", "https://l/slack/2")
    assert [set(r) for r in reply["result"]["results"]] == [{"connector", "status", "connect_url"}] * 3


def test_pr2b_native_connect_and_list_keep_the_r34_shapes(connector_op):
    """A native (``owner``) request is never reshaped: 4002 stays an error, the operation view keeps ``targets``."""
    (owner, _), op, _ = connector_op
    refused = owner.call("connectors.connect", {**NATIVE_LIST, "connectors": ["gmail"]})
    assert refused["error"] == {"code": 4002, "message": "Reopen the stored link.", "data": {"reason": "LINK_STILL_VALID"}}
    view = owner.call("connectors.connect", {**NATIVE_LIST, "connectors": ["slack"]})
    assert "results" not in view["result"] and view["result"]["op_id"] == op.op_id
    assert {t["name"]: t["state"] for t in view["result"]["targets"]} == {
        "gmail": "initiated", "notion": "connected", "slack": "initiated"}
    assert "connectionStatus" not in owner.call("connectors.list", NATIVE_LIST)["result"]["connectors"][0]


def test_pr2b_es9_connect_keeps_4004_authority_and_the_kill_switch(connector_op, monkeypatch):
    from tools.connectors import live

    (owner, stranger), op, mints = connector_op
    foreign = stranger.call("connectors.connect", {**ES9_CONNECT, "connectors": ["gmail"]})
    assert foreign["error"]["code"] == 4001 and "result" not in foreign  # another transport never sees the links
    monkeypatch.setenv(ENV, "0")
    assert owner.call("connectors.connect", {**ES9_CONNECT, "connectors": ["gmail"]})["error"]["code"] == 4000
    monkeypatch.setenv(ENV, "1")
    live.close(op)
    closed = owner.call("connectors.connect", {**ES9_CONNECT, "connectors": ["gmail"]})
    assert closed["error"]["data"]["reason"] == "UNKNOWN_OPERATION" and _es9_connect_phase(closed, "gmail") == ("error",)
    assert mints == []


def test_pr2b_es9_list_rows_carry_connection_status_for_grant_again(owned_session, monkeypatch):
    owner, _ = owned_session
    rows = [{"connector": "gmail", "enabled": True, "connected": False, "connection_status": "expired",
             "status_reason": "token revoked", "gateway_disabled_tools": []}]
    monkeypatch.setattr("model_tools.handle_function_call", lambda name, args, **kw: json.dumps({"connectors": rows}))
    row = owner.call("connectors.list", ES9_LIST)["result"]["connectors"][0]
    assert row["connectionStatus"] == row["connection_status"] == "expired"
    monkeypatch.setenv(ENV, "0")
    assert owner.call("connectors.list", NATIVE_LIST)["result"]["connectors"][0].get("connectionStatus") is None


def test_pr2b_es9_create_marks_the_session_so_a_detached_sudo_is_replayed(monkeypatch):
    """Review mL-SK: es.9 creates a session and detaches before the first prompt; a sudo raised then must enter the
    replay ring as ``sudo.request`` so the reconnecting es.9 (``session.events.since``) shows and answers it."""
    monkeypatch.setattr(server, "_schedule_agent_build", lambda _sid: None)
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda: None)
    es9 = _Peer()
    sid = _rpc(es9, "session.create", source="desktop", desktop_ui_protocol=3)["result"]["session_id"]
    try:
        session = server._sessions[sid]
        assert session.get("_lp_seen") is True
        server._detach_session_transport(session, es9)
        thread, box = _bg(lambda: server._ask("sudo", sid, {}, timeout=5))
        req = _open_request(sid)
        back = _Peer()
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            replay = _rpc(back, "session.events.since", session_id=sid, last_seen=0)["result"]["events"]
            twins = [e["payload"] for e in replay if e["type"] == "sudo.request"]
            if twins:
                break
            time.sleep(0.01)
        assert twins == [{"request_id": req.id}]
        assert _rpc(back, "sudo.respond", request_id=req.id, password="pw")["result"] == {"status": "ok"}
        thread.join(timeout=5)
        assert box["r"] == "pw"
    finally:
        server._close_session_by_id(sid, end_reason="test_cleanup")


def test_pr2b_session_create_does_not_mark_an_advertised_client_or_with_the_kill_switch(monkeypatch):
    monkeypatch.setattr(server, "_schedule_agent_build", lambda _sid: None)
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda: None)
    for peer, env in ((_Peer(advertised=True), "1"), (_Peer(), "0")):
        monkeypatch.setenv(ENV, env)
        sid = _rpc(peer, "session.create", source="desktop", desktop_ui_protocol=3)["result"]["session_id"]
        try:
            assert "_lp_seen" not in server._sessions[sid]
        finally:
            server._close_session_by_id(sid, end_reason="test_cleanup")


def test_pr2b_legacy_respond_never_settles_another_open_kind(monkeypatch):
    """Review thread on #369: sudo and secret open together; ``secret.respond`` naming the sudo's id is the legacy
    4009 and settles nothing; each card is then answered by its own kind."""
    old = _Peer()
    _session(monkeypatch, "ws-old", old)
    sudo_thread, sudo_box = _bg(lambda: server._ask("sudo", "ws-old", {}, timeout=5))
    sudo = _open_request("ws-old")
    secret_thread, secret_box = _bg(lambda: server._ask("secret", "ws-old", {"env_var": "K", "prompt": "p"}, timeout=5))
    deadline = time.monotonic() + 5
    while len(server_requests.open_requests("ws-old")) < 2 and time.monotonic() < deadline:
        time.sleep(0.01)
    secret = next(r for r in server_requests._open.values() if r.method == "secret")

    crossed = _rpc(old, "secret.respond", request_id=sudo.id, value="leaked")
    assert crossed["error"]["code"] == 4009 and "no pending value request" in crossed["error"]["message"]
    assert _rpc(old, "sudo.respond", request_id=secret.id, password="leaked")["error"]["code"] == 4009
    assert {r["id"] for r in server_requests.open_requests("ws-old")} == {sudo.id, secret.id}

    assert _rpc(old, "sudo.respond", request_id=sudo.id, password="pw")["result"] == {"status": "ok"}
    assert _rpc(old, "secret.respond", request_id=secret.id, value="v")["result"] == {"status": "ok"}
    sudo_thread.join(timeout=5)
    secret_thread.join(timeout=5)
    assert (sudo_box["r"], secret_box["r"]) == ("pw", "v")
    # A settled or unknown id still answers ``expired`` (upstream request.answer), never 4009.
    assert _rpc(old, "sudo.respond", request_id=sudo.id, password="late")["result"] == {"status": "expired"}


def _after_connect_dispatch(monkeypatch, then):
    """Run *then* right after the real ``connectors.connect`` handler answered, before the es.9 reply is shaped: the
    tool thread settling and closing the operation (``tools/connectors/run.py``) while the request is in flight."""
    real = server._methods["connectors.connect"]

    def handler(rid, params):
        response = real(rid, params)
        then()
        return response

    monkeypatch.setitem(server._methods, "connectors.connect", handler)


ES9_STILL_VALID = {"summary": {}, "results": [
    {"connector": "gmail", "status": "initiated", "connect_url": "https://l/gmail/1"},
    {"connector": "notion", "status": "active", "connect_url": "https://l/notion/1"},
    {"connector": "slack", "status": "initiated", "connect_url": "https://l/slack/1"}]}


def test_pr2b_es9_4002_is_answered_from_the_pre_dispatch_sample_when_the_operation_settles(connector_op, monkeypatch):
    """Review round 2: the dispatch answered 4002 LINK_STILL_VALID, then the operation settled and closed before the
    reply was shaped. es.9 still gets the still-valid link (sampled before dispatch), not the raw 4002."""
    from tools.connectors import live
    from tools.connectors.contract import SettleReason

    (owner, _), op, mints = connector_op
    _after_connect_dispatch(monkeypatch, lambda: (op.settle(SettleReason.interrupt), live.close(op)))
    reply = owner.call("connectors.connect", {**ES9_CONNECT, "connectors": ["gmail"]})
    assert op.settled and live.current(SID) is None
    assert reply["result"] == ES9_STILL_VALID
    assert _es9_connect_phase(reply, "gmail") == ("open", "https://l/gmail/1")
    assert mints == []


def test_pr2b_es9_4002_never_samples_a_successor_operation(connector_op, monkeypatch):
    """A successor operation opened in that window (another tool call on the same session) is never read: the reply
    carries the links of the operation the dispatch refused on."""
    from tools.connectors import live
    from tools.connectors.contract import Actor, SettleReason, TargetState
    from tools.connectors.operation import ConnectionOperation, Target

    (owner, _), op, mints = connector_op
    successor = ConnectionOperation([Target("gmail", "connector", "connect")], session_key=SID)

    def replace():
        op.settle(SettleReason.all_resolved)
        live.close(op)
        live.open(successor)
        successor.transition("gmail", TargetState.initiated, Actor.backend_watcher, connect_url="https://l/gmail/next")

    _after_connect_dispatch(monkeypatch, replace)
    reply = owner.call("connectors.connect", {**ES9_CONNECT, "connectors": ["gmail"]})
    assert live.current(SID) is successor
    assert reply["result"] == ES9_STILL_VALID
    assert "https://l/gmail/next" not in json.dumps(reply)
    assert mints == []


def test_pr2b_legacy_clarify_respond_on_another_open_kind_is_unchanged_from_base(monkeypatch):
    """Review round 2: the cross-kind check guards sudo/secret/tour/vault only. A legacy ``clarify.respond`` naming an
    id open as another kind behaves exactly as on base 840c2981: with a question_id it forwards to ``clarify.lock``
    (``expired``, nothing settled); without one (es.9's cancel-all) it forwards to ``request.answer``."""
    old = _Peer()
    _session(monkeypatch, "ws-old", old)
    thread, box = _bg(lambda: server._ask("sudo", "ws-old", {}, timeout=5))
    sudo = _open_request("ws-old")
    assert _rpc(old, "clarify.respond", request_id=sudo.id, question_id="q0", answer="x")["result"] == {
        "status": "expired"}
    assert [r["id"] for r in server_requests.open_requests("ws-old")] == [sudo.id]
    assert _rpc(old, "clarify.respond", request_id=sudo.id, answer="x")["result"] == {"status": "ok"}
    thread.join(timeout=5)
    assert box["r"] == "" and not server_requests.open_requests("ws-old")
