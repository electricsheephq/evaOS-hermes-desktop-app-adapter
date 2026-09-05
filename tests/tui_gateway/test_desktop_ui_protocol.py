"""Desktop UI capabilities are negotiated per attached client session."""

import asyncio
import io
import json
import logging
import threading
import types

import pytest

from tools import desktop_ui
from tools.drive_preview_tool import drive_preview_tool
from tools.open_preview_tool import open_preview_tool
from tools.preview_tool import preview_close
from tools.read_preview_tool import read_preview_tool
from tools.registry import registry
from toolsets import resolve_toolset
import tui_gateway.server as server


PROTOCOL_1_TOOLS = {
    "read_terminal",
    "close_terminal",
    "desktop_preview",
    "focus_pane",
    "react_to_message",
}

PROTOCOL_2_TOOLS = {
    "drive_preview",
    "annotate_preview",
    "read_window_below",
    "setup_mcp",
    "gui_tour",
    "apply_layout",
}


def test_legacy_desktop_exposes_only_protocol_1_tools():
    """ES17 sends no marker, so r30 must not advertise responders it lacks."""
    surface = server._gui_surface_toolsets("desktop")

    assert surface == {"project", "desktop_ui"}
    assert set(resolve_toolset("desktop_ui")) == PROTOCOL_1_TOOLS


def test_matched_desktop_exposes_protocol_2_tools():
    surface = server._gui_surface_toolsets("desktop", desktop_ui_protocol=2)

    assert surface == {"desktop_ui", "desktop_ui_v2"}
    assert set(resolve_toolset("desktop_ui_v2")) == PROTOCOL_2_TOOLS


def test_non_desktop_never_gets_desktop_ui_tools():
    assert server._gui_surface_toolsets("tui", desktop_ui_protocol=2) == set()


@pytest.mark.parametrize(
    ("protocol", "actions"),
    [
        (1, ["open"]),
        (2, ["open", "close", "read"]),
        (3, ["open", "close", "read"]),
    ],
)
def test_consolidated_preview_schema_filters_actions_by_protocol(monkeypatch, protocol, actions):
    sid = f"schema-{protocol}"
    server._sessions[sid] = {"source": "desktop", "desktop_ui_protocol": protocol}
    monkeypatch.setattr(
        desktop_ui,
        "get_session_env",
        lambda name, default="": sid if name == "HERMES_UI_SESSION_ID" else default,
    )
    desktop_ui.set_protocol_resolver(server._desktop_ui_emitter_protocol_error)
    desktop_ui.set_protocol_level_resolver(server._desktop_ui_protocol_level)
    try:
        entry = registry.get_entry("desktop_preview")
        assert entry is not None and entry.dynamic_schema_overrides is not None
        schema = entry.dynamic_schema_overrides()
        assert schema["parameters"]["properties"]["action"]["enum"] == actions
    finally:
        desktop_ui.set_protocol_resolver(None)
        desktop_ui.set_emitter(None)
        server._sessions.pop(sid, None)


@pytest.mark.parametrize(
    ("source", "requested", "expected"),
    [
        ("desktop", None, 1),
        ("desktop", "2", 1),
        ("desktop", True, 1),
        ("desktop", 1, 1),
        ("desktop", 2, 2),
        ("desktop", 99, 3),
        ("tui", 2, 0),
        ("telegram", 2, 0),
    ],
)
def test_protocol_negotiation_is_numeric_and_source_bound(source, requested, expected):
    assert server._negotiate_desktop_ui_protocol(source, requested) == expected


def test_legacy_reused_session_rejects_read_before_wait(monkeypatch):
    """A protocol-2 tool left in a warm agent must fail before the 45s bridge."""
    sid = "legacy-ui"
    calls = []
    server._sessions[sid] = {"source": "desktop", "desktop_ui_protocol": 1}
    monkeypatch.setattr(
        server,
        "_block",
        lambda *args, **kwargs: calls.append((args, kwargs)) or json.dumps({"ok": True}),
    )
    try:
        raw = server._agent_cbs(sid)["read_preview_callback"]()
    finally:
        server._sessions.pop(sid, None)

    assert calls == []
    assert json.loads(raw) == {
        "error": "This Desktop client needs an update before it can use desktop_preview.read.",
        "code": "desktop_ui_protocol_upgrade_required",
        "required_protocol": 2,
        "negotiated_protocol": 1,
    }


def test_legacy_reused_session_names_annotate_upgrade_error(caplog, monkeypatch):
    """Annotations share the act channel but retain their own tool identity."""
    sid = "legacy-annotation"
    calls = []
    server._sessions[sid] = {"source": "desktop", "desktop_ui_protocol": 1}
    monkeypatch.setattr(
        server,
        "_block",
        lambda *args, **kwargs: calls.append((args, kwargs)) or "unexpected",
    )
    try:
        with caplog.at_level(logging.DEBUG, logger=server.logger.name):
            raw = server._agent_cbs(sid)["annotate_preview_callback"](
                {"action": "pin", "ref": "@e1"}
            )
    finally:
        server._sessions.pop(sid, None)

    assert calls == []
    assert json.loads(raw) == {
        "error": "This Desktop client needs an update before it can use annotate_preview.",
        "code": "desktop_ui_protocol_upgrade_required",
        "required_protocol": 2,
        "negotiated_protocol": 1,
    }
    logs = "\n".join(record.getMessage() for record in caplog.records)
    assert "tool=annotate_preview outcome=protocol_blocked" in logs
    assert "tool=drive_preview" not in logs


def test_matched_session_makes_exactly_one_renderer_request(monkeypatch):
    sid = "matched-ui"
    calls = []
    transport = object()
    server._sessions[sid] = {
        "source": "desktop",
        "desktop_ui_protocol": 2,
        "transport": transport,
    }
    monkeypatch.setattr(
        server,
        "_block",
        lambda *args, **kwargs: calls.append((args, kwargs))
        or json.dumps({"title": "Example Domain"}),
    )
    try:
        raw = server._agent_cbs(sid)["read_preview_callback"]()
    finally:
        server._sessions.pop(sid, None)

    assert json.loads(raw) == {"title": "Example Domain"}
    assert calls == [
        (
            ("preview.read.request", sid, {}),
            {"timeout": 45, "transport": transport},
        )
    ]


def test_matched_open_read_drive_round_trip(monkeypatch):
    sid = "matched-round-trip"
    emitted = []
    blocked = []
    server._sessions[sid] = {"source": "desktop", "desktop_ui_protocol": 2}
    monkeypatch.setattr(
        desktop_ui,
        "get_session_env",
        lambda name, default="": sid if name == "HERMES_UI_SESSION_ID" else default,
    )

    def fake_block(event, current_sid, payload, timeout=None, **_kwargs):
        blocked.append((event, current_sid, payload, timeout))
        if event == "preview.read.request":
            return json.dumps({"title": "Example Domain", "text": "Example Domain"})
        return json.dumps(
            {"action": "elements", "elements": [{"ref": "lnk-more", "role": "link"}]}
        )

    monkeypatch.setattr(server, "_block", fake_block)
    desktop_ui.set_protocol_resolver(server._desktop_ui_emitter_protocol_error)
    desktop_ui.set_emitter(
        lambda current_sid, event, payload: emitted.append(
            (current_sid, event, payload)
        )
    )
    try:
        callbacks = server._agent_cbs(sid)
        opened = json.loads(open_preview_tool("https://example.com"))
        read = json.loads(
            read_preview_tool(callback=callbacks["read_preview_callback"])
        )
        elements = json.loads(
            drive_preview_tool(
                action="elements", callback=callbacks["drive_preview_callback"]
            )
        )
        closed = json.loads(preview_close())
    finally:
        desktop_ui.set_protocol_resolver(None)
        desktop_ui.set_emitter(None)
        server._sessions.pop(sid, None)

    assert opened["status"] == "dispatched"
    assert read["title"] == "Example Domain"
    assert elements["elements"] == [{"ref": "lnk-more", "role": "link"}]
    assert closed == {"success": True, "closed": "all"}
    assert emitted == [
        (sid, "preview.open", {"url": "https://example.com", "label": ""}),
        (sid, "preview.close", {"url": ""}),
    ]
    assert blocked == [
        ("preview.read.request", sid, {}, 45),
        ("preview.act.request", sid, {"action": "elements"}, 45),
    ]


def test_non_desktop_session_cannot_reuse_a_protocol_two_callback(monkeypatch):
    sid = "background-ui"
    calls = []
    server._sessions[sid] = {"source": "tui", "desktop_ui_protocol": 2}
    monkeypatch.setattr(
        server,
        "_block",
        lambda *args, **kwargs: calls.append((args, kwargs)) or "unexpected",
    )
    try:
        raw = server._agent_cbs(sid)["drive_preview_callback"](
            {"action": "elements"}
        )
    finally:
        server._sessions.pop(sid, None)

    assert calls == []
    assert json.loads(raw) == {
        "error": "drive_preview is only available to the Desktop client that owns this session.",
        "code": "desktop_ui_unavailable",
        "required_protocol": 2,
        "negotiated_protocol": 0,
    }


def test_create_and_activate_store_and_rebind_protocol(monkeypatch):
    monkeypatch.setattr(server, "_schedule_agent_build", lambda _sid: None)
    monkeypatch.setattr(server, "_schedule_session_cap_enforcement", lambda: None)
    created = server._methods["session.create"](
        1, {"source": "desktop", "desktop_ui_protocol": 2}
    )
    sid = created["result"]["session_id"]
    try:
        assert server._sessions[sid]["desktop_ui_protocol"] == 2
        monkeypatch.setattr(
            server,
            "_live_session_payload",
            lambda current_sid, _session, **_kwargs: {"session_id": current_sid},
        )
        activated = server._methods["session.activate"](
            2, {"session_id": sid, "source": "desktop"}
        )
        assert "error" not in activated
        assert server._sessions[sid]["source"] == "desktop"
        assert server._sessions[sid]["desktop_ui_protocol"] == 1

        activated = server._methods["session.activate"](
            3,
            {
                "session_id": sid,
                "source": "desktop",
                "desktop_ui_protocol": 2,
            },
        )
        assert "error" not in activated
        assert server._sessions[sid]["source"] == "desktop"
        assert server._sessions[sid]["desktop_ui_protocol"] == 2

        calls = []
        monkeypatch.setattr(
            server,
            "_block",
            lambda *args, **kwargs: calls.append((args, kwargs)) or "unexpected",
        )
        activated = server._methods["session.activate"](
            4,
            {
                "session_id": sid,
                "source": "tui",
                "desktop_ui_protocol": 2,
            },
        )
        assert "error" not in activated
        assert server._sessions[sid]["source"] == "tui"
        assert server._sessions[sid]["desktop_ui_protocol"] == 0
        # session.branch consumes this exact pair. Re-negotiating the already
        # authoritative zero under a stale Desktop source would restore v1.
        assert server._negotiate_desktop_ui_protocol(
            server._session_source(server._sessions[sid]),
            server._sessions[sid]["desktop_ui_protocol"],
        ) == 0
        raw = server._agent_cbs(sid)["read_terminal_callback"]()
        assert calls == []
        assert json.loads(raw)["code"] == "desktop_ui_unavailable"

        activated = server._methods["session.activate"](5, {"session_id": sid})
        assert "error" not in activated
        assert server._sessions[sid]["source"] == "tui"
        assert server._sessions[sid]["desktop_ui_protocol"] == 0
    finally:
        server._sessions.pop(sid, None)


def test_rebind_publishes_protocol_and_transport_as_one_snapshot(monkeypatch):
    """A protocol upgrade cannot expose v2 while the legacy transport is live."""
    sid = "concurrent-upgrade"
    protocol_published = threading.Event()
    allow_transport_publish = threading.Event()
    request_finished = threading.Event()
    errors = []
    blocked_transports = []

    class _Transport:
        def __init__(self, name):
            self.name = name

        def write(self, _frame):
            return True

    class _PausingSession(dict):
        def __setitem__(self, key, value):
            super().__setitem__(key, value)
            if key == "desktop_ui_protocol" and value == 2:
                protocol_published.set()
                allow_transport_publish.wait(timeout=2)

    legacy = _Transport("legacy")
    current = _Transport("current")
    session = _PausingSession(
        {
            "source": "desktop",
            "desktop_ui_protocol": 1,
            "history_lock": threading.Lock(),
            "transport": legacy,
        }
    )
    server._sessions[sid] = session

    def fake_block(_event, _sid, _payload, **kwargs):
        blocked_transports.append(kwargs.get("transport"))
        return json.dumps({"title": "Example Domain"})

    monkeypatch.setattr(server, "_block", fake_block)

    def rebind():
        try:
            server._bind_session_attachment(
                session,
                "desktop",
                2,
                transport=current,
            )
        except Exception as exc:  # pragma: no cover - asserted below
            errors.append(exc)

    def request():
        try:
            server._agent_cbs(sid)["read_preview_callback"]()
        except Exception as exc:  # pragma: no cover - asserted below
            errors.append(exc)
        finally:
            request_finished.set()

    bind_thread = threading.Thread(target=rebind)
    request_thread = threading.Thread(target=request)
    bind_thread.start()
    try:
        assert protocol_published.wait(timeout=1)
        request_thread.start()
        completed_while_attachment_was_partial = request_finished.wait(timeout=0.05)
    finally:
        allow_transport_publish.set()
        bind_thread.join(timeout=1)
        request_thread.join(timeout=1)
        server._sessions.pop(sid, None)

    assert completed_while_attachment_was_partial is False
    assert errors == []
    assert blocked_transports == [current]


def test_fire_and_forget_rechecks_attachment_before_routing(monkeypatch):
    """A downgrade between preflight and emit cannot reach the legacy client."""
    sid = "fire-and-forget-downgrade"

    class _Transport:
        def __init__(self):
            self.frames = []

        def write(self, frame):
            self.frames.append(frame)
            return True

    current = _Transport()
    legacy = _Transport()
    session = {
        "source": "desktop",
        "desktop_ui_protocol": 2,
        "history_lock": threading.Lock(),
        "transport": current,
    }
    server._sessions[sid] = session
    monkeypatch.setattr(
        desktop_ui,
        "get_session_env",
        lambda name, default="": sid if name == "HERMES_UI_SESSION_ID" else default,
    )
    previous_emitter = desktop_ui._emit
    previous_resolver = desktop_ui._protocol_error
    previous_wired = server._desktop_ui_wired
    server._desktop_ui_wired = False
    server._wire_desktop_sinks()

    def downgrade_after_preflight(current_sid, event):
        error = server._desktop_ui_emitter_protocol_error(current_sid, event)
        if error is None:
            server._bind_session_attachment(
                session,
                "desktop",
                1,
                transport=legacy,
            )
        return error

    desktop_ui.set_protocol_resolver(downgrade_after_preflight)
    try:
        assert desktop_ui.emit("preview.close", {}) is False
    finally:
        desktop_ui.set_emitter(previous_emitter)
        desktop_ui.set_protocol_resolver(previous_resolver)
        server._desktop_ui_wired = previous_wired
        server._sessions.pop(sid, None)

    assert current.frames == []
    assert legacy.frames == []


@pytest.mark.parametrize("attachment_state", ["detached", "closed"])
@pytest.mark.parametrize("action", ["open", "close", "tip"])
def test_fire_and_forget_reports_failed_transport_write(
    monkeypatch, caplog, attachment_state, action,
):
    """A resumable session must not report delivery to a disconnected renderer."""
    from tools.tip_tool import tip_tool
    from tui_gateway.ws import WSTransport

    sid = "synthetic-disconnected-owner"
    loop = asyncio.new_event_loop()
    transport = WSTransport(None, loop)
    monkeypatch.setitem(server._sessions, sid, {
        "source": "desktop",
        "desktop_ui_protocol": 3,
        "transport": transport,
        "close_on_disconnect": False,
    })
    monkeypatch.setattr(server, "_schedule_ws_orphan_reap", lambda _sid: None)
    monkeypatch.setattr(desktop_ui, "_emit", server._desktop_ui_emit)
    monkeypatch.setattr(
        desktop_ui, "_protocol_error", server._desktop_ui_emitter_protocol_error,
    )
    monkeypatch.setattr(
        desktop_ui, "get_session_env",
        lambda name, default="": sid if name == "HERMES_UI_SESSION_ID" else default,
    )
    monkeypatch.setattr(
        server, "_block",
        lambda *_args, **_kwargs: pytest.fail("fire-and-forget must not wait"),
    )
    try:
        if attachment_state == "detached":
            assert server._close_sessions_for_transport(transport) == (0, 1)
            assert server._sessions[sid]["transport"] is server._detached_ws_transport
        else:
            transport.close()
        with caplog.at_level(logging.DEBUG, logger=server.logger.name):
            if action == "open":
                raw = open_preview_tool("https://example.com")
            elif action == "close":
                raw = preview_close()
            else:
                raw = tip_tool("synthetic tip payload", "[data-tour=preview]")
    finally:
        transport.close()
        loop.close()

    result = json.loads(raw)
    assert result.get("error")
    assert not result.get("success")
    logs = "\n".join(record.getMessage() for record in caplog.records)
    assert logs.count("outcome=transport_unavailable") == 1
    assert "outcome=dispatched" not in logs
    for excluded in (sid, "example.com", "synthetic tip payload", "data-tour"):
        assert excluded not in logs


def test_fire_and_forget_retains_one_successful_owner_write(monkeypatch, caplog):
    sid = "synthetic-connected-owner"
    frames = []

    class _AcceptingTransport:
        def write(self, frame):
            frames.append(frame)
            return True

    monkeypatch.setitem(server._sessions, sid, {
        "source": "desktop",
        "desktop_ui_protocol": 3,
        "transport": _AcceptingTransport(),
    })
    monkeypatch.setattr(desktop_ui, "_emit", server._desktop_ui_emit)
    monkeypatch.setattr(
        desktop_ui, "_protocol_error", server._desktop_ui_emitter_protocol_error,
    )
    monkeypatch.setattr(
        desktop_ui, "get_session_env",
        lambda name, default="": sid if name == "HERMES_UI_SESSION_ID" else default,
    )
    with caplog.at_level(logging.DEBUG, logger=server.logger.name):
        result = json.loads(open_preview_tool("https://example.com"))

    assert result["success"] is True
    assert result["status"] == "dispatched"
    assert len(frames) == 1
    assert frames[0]["params"]["type"] == "preview.open"
    logs = "\n".join(record.getMessage() for record in caplog.records)
    assert logs.count("outcome=dispatched") == 1
    assert "outcome=transport_unavailable" not in logs
    assert sid not in logs
    assert "example.com" not in logs


def test_compute_host_carries_and_rebinds_desktop_ui_protocol():
    from tui_gateway.compute_host import ComputeHost

    parent = {
        "attached_images": [],
        "cols": 80,
        "cwd": "/tmp",
        "desktop_ui_protocol": 2,
        "history": [],
        "history_lock": threading.Lock(),
        "history_version": 0,
        "session_key": "compute-key",
        "source": "desktop",
    }
    frame = server._compute_host_turn_frame("request", "compute-sid", parent, "hello")
    assert frame["desktop_ui_protocol"] == 2

    captured = {}
    fake_server = types.SimpleNamespace(_sessions={})

    def fake_make_agent(*_args, **kwargs):
        captured["make"] = kwargs
        return types.SimpleNamespace()

    def fake_init_session(sid, key, agent, history, **kwargs):
        captured["init"] = kwargs
        fake_server._sessions[sid] = {
            "agent": agent,
            "history": history,
            "session_key": key,
            "source": kwargs.get("source"),
            "desktop_ui_protocol": kwargs.get("desktop_ui_protocol"),
        }

    fake_server._make_agent = fake_make_agent
    fake_server._init_session = fake_init_session
    fake_server._transfer_db_to_agent = lambda *_args: False
    fake_server._resolve_session_source = server._resolve_session_source
    fake_server._negotiate_desktop_ui_protocol = server._negotiate_desktop_ui_protocol
    fake_server._bind_session_attachment = server._bind_session_attachment

    host = ComputeHost(stdout=io.StringIO(), heartbeat_secs=0)
    try:
        created = host._ensure_server_session(fake_server, frame)
        assert created["desktop_ui_protocol"] == 2
        assert captured["make"]["desktop_ui_protocol_override"] == 2
        assert captured["init"]["desktop_ui_protocol"] == 2

        existing = {
            "desktop_ui_protocol": 1,
            "source": "desktop",
            "transport": None,
        }
        fake_server._sessions["compute-sid"] = existing
        rebound = host._ensure_server_session(fake_server, frame)
        assert rebound["source"] == "desktop"
        assert rebound["desktop_ui_protocol"] == 2
    finally:
        host.close()


def test_disconnect_restores_surviving_viewer_protocol(monkeypatch):
    monkeypatch.setattr(server, "_schedule_ws_orphan_reap", lambda _sid: None)

    class _LiveTransport:
        def write(self, *_args, **_kwargs):
            return True

    legacy = _LiveTransport()
    current = _LiveTransport()
    session = {
        "close_on_disconnect": False,
        "desktop_ui_protocol": 1,
        "source": "desktop",
        "transport": legacy,
        "viewers": {
            current: {
                "attached_at": 100.0,
                "desktop_ui_protocol": 2,
                "source": "desktop",
            },
            legacy: {
                "attached_at": 200.0,
                "desktop_ui_protocol": 1,
                "source": "desktop",
            },
        },
    }
    server._sessions["viewer-protocol"] = session
    try:
        reaped, detached = server._close_sessions_for_transport(legacy)
        assert (reaped, detached) == (0, 0)
        assert session["transport"] is current
        assert session["source"] == "desktop"
        assert session["desktop_ui_protocol"] == 2
    finally:
        server._sessions.pop("viewer-protocol", None)


def test_deferred_cold_session_stores_negotiated_protocol():
    record = server._deferred_session_record(
        "stored-session",
        cols=80,
        cwd="/tmp",
        history=[],
        lease=None,
        source="desktop",
        desktop_ui_protocol=2,
    )

    assert record["desktop_ui_protocol"] == 2


def test_session_agent_rebuilds_preserve_negotiated_protocol(monkeypatch):
    captured = []

    def fake_make_agent(*_args, **kwargs):
        captured.append(kwargs)
        return types.SimpleNamespace(model="synthetic")

    monkeypatch.setattr(server, "_make_agent", fake_make_agent)
    monkeypatch.setattr(server, "_set_session_context", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(server, "_clear_session_context", lambda _tokens: None)
    monkeypatch.setattr(server, "_config_model_target", lambda: ("", ""))
    monkeypatch.setattr(server, "_load_show_reasoning", lambda: True)
    monkeypatch.setattr(server, "_load_tool_progress_mode", lambda: "all")
    monkeypatch.setattr(server, "_session_info", lambda *_args: {})
    monkeypatch.setattr(server, "_emit", lambda *_args: None)
    monkeypatch.setattr(server, "_restart_slash_worker", lambda *_args: None)

    reset_session = {
        "agent": types.SimpleNamespace(model="synthetic"),
        "session_key": "reset-key",
        "source": "desktop",
        "desktop_ui_protocol": 2,
        "history": [],
        "history_lock": threading.Lock(),
    }
    server._reset_session_agent("reset-sid", reset_session)

    import tools.bot_mode_probe as bot_mode_probe

    monkeypatch.setattr(bot_mode_probe, "capability_fingerprint", lambda _home: "new")
    bot_session = {
        "agent": types.SimpleNamespace(_session_title_hint="Bot Chat"),
        "session_key": "bot-key",
        "source": "desktop",
        "desktop_ui_protocol": 2,
        "profile_home": None,
        "bot_caps_seen": "old",
    }
    server._sync_bot_capabilities("bot-sid", bot_session)

    assert [item["desktop_ui_protocol_override"] for item in captured] == [2, 2]


def test_reload_mcp_preserves_session_protocol_surface(monkeypatch):
    import tools.mcp_tool_agent as mcp_tool_agent
    import tools.mcp_tool_discovery as mcp_tool_discovery
    import tools.mcp_tool_lifecycle as mcp_tool_lifecycle

    sid = "reload-ui"
    agent = types.SimpleNamespace(enabled_toolsets=[])
    server._sessions[sid] = {
        "agent": agent,
        "source": "desktop",
        "desktop_ui_protocol": 2,
    }
    loaded = []
    refreshed = []
    saved = (server._mcp_reload_gen, server._mcp_reload_loaded_rev)
    server._mcp_reload_gen = 0
    server._mcp_reload_loaded_rev = ""
    monkeypatch.setattr(mcp_tool_lifecycle, "shutdown_mcp_servers", lambda: None)
    monkeypatch.setattr(mcp_tool_agent, "reprobe_tool_availability", lambda: None)
    monkeypatch.setattr(mcp_tool_discovery, "discover_mcp_tools", lambda: None)
    monkeypatch.setattr(server, "_compute_mcp_rev", lambda: "stable")
    monkeypatch.setattr(server, "_emit", lambda *_args: None)
    monkeypatch.setattr(server, "_session_info", lambda *_args: {})

    def fake_load(platform=None, protocol=None):
        loaded.append((platform, protocol))
        return ["desktop_ui", "desktop_ui_v2"]

    monkeypatch.setattr(server, "_load_enabled_toolsets", fake_load)
    monkeypatch.setattr(
        mcp_tool_agent,
        "refresh_agent_mcp_tools",
        lambda current_agent, **kwargs: refreshed.append((current_agent, kwargs)) or set(),
    )
    try:
        response = server._methods["reload.mcp"](
            1, {"session_id": sid, "confirm": True}
        )
    finally:
        server._sessions.pop(sid, None)
        server._mcp_reload_gen, server._mcp_reload_loaded_rev = saved

    assert response["result"]["status"] == "reloaded"
    assert loaded == [("desktop", 2)]
    assert refreshed == [
        (
            agent,
            {
                "enabled_override": ["desktop_ui", "desktop_ui_v2"],
                "quiet_mode": True,
            },
        )
    ]


def test_legacy_open_preview_description_does_not_name_v2_only_tools():
    from tools.open_preview_tool import OPEN_PREVIEW_SCHEMA

    description = OPEN_PREVIEW_SCHEMA["description"]
    assert "read_preview" not in description
    assert "close_preview" not in description


def test_lifecycle_logs_exclude_payload_and_raw_session(caplog, monkeypatch):
    sid = "raw-session-secret"
    server._sessions[sid] = {"source": "desktop", "desktop_ui_protocol": 2}
    monkeypatch.setattr(server, "_block", lambda *_args, **_kwargs: "")
    try:
        with caplog.at_level(logging.DEBUG, logger=server.logger.name):
            server._agent_cbs(sid)["drive_preview_callback"](
                {
                    "action": "elements",
                    "url": "https://private.invalid/path",
                    "token": "do-not-log",
                    "text": "private DOM text",
                }
            )
    finally:
        server._sessions.pop(sid, None)

    logs = "\n".join(record.getMessage() for record in caplog.records)
    assert "outcome=expired" in logs
    assert server._desktop_ui_session_ref(sid) in logs
    for forbidden in (
        sid,
        "private.invalid",
        "do-not-log",
        "private DOM text",
    ):
        assert forbidden not in logs
