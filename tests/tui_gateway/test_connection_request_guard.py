"""evaOS (r34 review, RE-7): the ``manage_connections`` card (``connection.request``) on a Desktop
session reaches only the viewer whose prompt started the turn, through that viewer's own peer transport,
and only when that viewer negotiated Desktop UI protocol 2. Other viewers attached to the same session
(the production ``FanoutTransport``) never receive it. Non-Desktop surfaces (the TUI renders the card)
keep upstream's session emit."""

import threading
import time

import pytest

import tui_gateway.server as server
from tui_gateway.transport import FanoutTransport

PAYLOAD = {"op_id": "op-1", "seq": 1, "deadline_at": 0.0, "timeout_seconds": 300.0, "targets": []}


class _Viewer:
    def __init__(self):
        self.frames = []
        self._lock = threading.Lock()

    def write(self, frame):
        with self._lock:
            self.frames.append(frame)
        return True

    def types(self):
        with self._lock:
            return [frame["params"]["type"] for frame in self.frames]


def _fanout(monkeypatch):
    frames = []
    monkeypatch.setattr(server, "write_json", lambda frame: frames.append(frame) or True)
    return frames


def _types(frames):
    return [frame["params"]["type"] for frame in frames]


def _viewer_entry(protocol):
    return {"attached_at": time.time(), "source": "desktop", "desktop_ui_protocol": protocol}


def _settle(*viewers, marker_sid):
    """The fanout drains on per-peer threads: flush with a marker event every peer must see."""
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if all("marker" in viewer.types() for viewer in viewers):
            return
        time.sleep(0.01)
    raise AssertionError("fanout did not drain")


def _shared_session(monkeypatch, sid, *, requester_protocol, other_protocol):
    requester, other = _Viewer(), _Viewer()
    route = FanoutTransport(requester, other)
    monkeypatch.setitem(server._sessions, sid, {
        "source": "desktop", "desktop_ui_protocol": requester_protocol, "transport": route,
        "viewers": {requester: _viewer_entry(requester_protocol), other: _viewer_entry(other_protocol)},
        "_turn_requester_transport": requester,
    })
    return requester, other, route


@pytest.mark.parametrize("other_protocol", [1, 2])
def test_shared_session_card_reaches_only_the_requesting_viewer(monkeypatch, other_protocol):
    sid = f"connection-shared-{other_protocol}"
    fanout = _fanout(monkeypatch)
    requester, other, route = _shared_session(monkeypatch, sid, requester_protocol=2, other_protocol=other_protocol)

    server._agent_cbs(sid)["connection_callback"](dict(PAYLOAD))
    server._emit("marker", sid, {}, transport=route)  # ordinary session traffic still fans out
    _settle(requester, other, marker_sid=sid)

    assert requester.types() == ["connection.request", "marker"]
    assert requester.frames[0]["params"]["payload"]["op_id"] == "op-1"
    assert other.types() == ["marker"]
    assert fanout == []


def test_shared_session_without_a_resolvable_requester_refuses_the_card(monkeypatch):
    sid = "connection-shared-no-requester"
    fanout = _fanout(monkeypatch)
    requester, other, route = _shared_session(monkeypatch, sid, requester_protocol=2, other_protocol=2)
    server._sessions[sid]["_turn_requester_transport"] = None

    server._agent_cbs(sid)["connection_callback"](dict(PAYLOAD))
    server._emit("marker", sid, {}, transport=route)
    _settle(requester, other, marker_sid=sid)

    assert requester.types() == ["marker"]
    assert other.types() == ["marker"]
    assert fanout == []


def test_requester_on_protocol_1_is_refused_even_when_the_session_negotiated_2(monkeypatch):
    sid = "connection-shared-legacy-requester"
    fanout = _fanout(monkeypatch)
    requester, other, route = _shared_session(monkeypatch, sid, requester_protocol=1, other_protocol=2)
    server._sessions[sid]["desktop_ui_protocol"] = 2

    server._agent_cbs(sid)["connection_callback"](dict(PAYLOAD))
    server._emit("marker", sid, {}, transport=route)
    _settle(requester, other, marker_sid=sid)

    assert requester.types() == ["marker"]
    assert other.types() == ["marker"]
    assert fanout == []


def test_negotiated_desktop_viewer_alone_receives_the_card(monkeypatch):
    sid = "connection-owner"
    owner, fanout = _Viewer(), _fanout(monkeypatch)
    monkeypatch.setitem(server._sessions, sid, {
        "source": "desktop", "desktop_ui_protocol": 2, "transport": owner,
        "viewers": {owner: _viewer_entry(2)}, "_turn_requester_transport": owner})

    server._agent_cbs(sid)["connection_callback"](dict(PAYLOAD))

    assert owner.types() == ["connection.request"]
    assert fanout == []


def test_legacy_desktop_viewer_does_not_receive_the_card(monkeypatch):
    sid = "connection-legacy"
    owner, fanout = _Viewer(), _fanout(monkeypatch)
    monkeypatch.setitem(server._sessions, sid, {
        "source": "desktop", "desktop_ui_protocol": 1, "transport": owner,
        "viewers": {owner: _viewer_entry(1)}, "_turn_requester_transport": owner})

    server._agent_cbs(sid)["connection_callback"](dict(PAYLOAD))

    assert owner.frames == []
    assert fanout == []


def test_tui_session_keeps_the_upstream_session_emit(monkeypatch):
    sid = "connection-tui"
    fanout = _fanout(monkeypatch)
    monkeypatch.setitem(server._sessions, sid, {"source": "tui"})

    server._agent_cbs(sid)["connection_callback"](dict(PAYLOAD))

    assert _types(fanout) == ["connection.request"]
