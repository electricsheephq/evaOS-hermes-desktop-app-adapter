"""evaOS (r34 review, RE-7): the ``manage_connections`` card (``connection.request``) on a Desktop
session reaches only the requesting viewer, and only when it negotiated Desktop UI protocol 2.
Non-Desktop surfaces (the TUI renders the card) keep upstream's session emit."""

import tui_gateway.server as server

PAYLOAD = {"op_id": "op-1", "seq": 1, "deadline_at": 0.0, "timeout_seconds": 300.0, "targets": []}


class _Viewer:
    def __init__(self):
        self.frames = []

    def write(self, frame):
        self.frames.append(frame)
        return True


def _fanout(monkeypatch):
    frames = []
    monkeypatch.setattr(server, "write_json", lambda frame: frames.append(frame) or True)
    return frames


def _types(frames):
    return [frame["params"]["type"] for frame in frames]


def test_negotiated_desktop_viewer_alone_receives_the_card(monkeypatch):
    sid = "connection-owner"
    owner, fanout = _Viewer(), _fanout(monkeypatch)
    monkeypatch.setitem(server._sessions, sid, {"source": "desktop", "desktop_ui_protocol": 2, "transport": owner})

    server._agent_cbs(sid)["connection_callback"](dict(PAYLOAD))

    assert _types(owner.frames) == ["connection.request"]
    assert owner.frames[0]["params"]["payload"]["op_id"] == "op-1"
    assert fanout == []  # never fanned out to other viewers of the session


def test_legacy_desktop_viewer_does_not_receive_the_card(monkeypatch):
    sid = "connection-legacy"
    owner, fanout = _Viewer(), _fanout(monkeypatch)
    monkeypatch.setitem(server._sessions, sid, {"source": "desktop", "desktop_ui_protocol": 1, "transport": owner})

    server._agent_cbs(sid)["connection_callback"](dict(PAYLOAD))

    assert owner.frames == []
    assert fanout == []


def test_tui_session_keeps_the_upstream_session_emit(monkeypatch):
    sid = "connection-tui"
    fanout = _fanout(monkeypatch)
    monkeypatch.setitem(server._sessions, sid, {"source": "tui"})

    server._agent_cbs(sid)["connection_callback"](dict(PAYLOAD))

    assert _types(fanout) == ["connection.request"]
