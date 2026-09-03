"""Desktop UI capabilities are negotiated per attached client session."""

import logging
import json
import threading
import types

import pytest

from tools import desktop_ui
from tools.drive_preview_tool import drive_preview_tool
from tools.open_preview_tool import open_preview_tool
from tools.read_preview_tool import read_preview_tool
from toolsets import resolve_toolset
import tui_gateway.server as server


PROTOCOL_1_TOOLS = {
    "read_terminal",
    "close_terminal",
    "open_preview",
    "focus_pane",
    "react_to_message",
}

PROTOCOL_2_TOOLS = {
    "close_preview",
    "read_preview",
    "drive_preview",
    "annotate_preview",
    "read_window_below",
    "setup_mcp",
    "tour",
    "apply_layout",
}


def test_legacy_desktop_exposes_only_protocol_1_tools():
    """ES17 sends no marker, so r30 must not advertise responders it lacks."""
    surface = server._gui_surface_toolsets("desktop")

    assert surface == {"project", "desktop_ui"}
    assert set(resolve_toolset("desktop_ui")) == PROTOCOL_1_TOOLS


def test_matched_desktop_exposes_protocol_2_tools():
    surface = server._gui_surface_toolsets("desktop", desktop_ui_protocol=2)

    assert surface == {"project", "desktop_ui", "desktop_ui_v2"}
    assert set(resolve_toolset("desktop_ui_v2")) == PROTOCOL_2_TOOLS


def test_non_desktop_never_gets_desktop_ui_tools():
    assert server._gui_surface_toolsets("tui", desktop_ui_protocol=2) == {"project"}


@pytest.mark.parametrize(
    ("source", "requested", "expected"),
    [
        ("desktop", None, 1),
        ("desktop", "2", 1),
        ("desktop", True, 1),
        ("desktop", 1, 1),
        ("desktop", 2, 2),
        ("desktop", 99, 2),
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
        "error": "This Desktop client needs an update before it can use read_preview.",
        "code": "desktop_ui_protocol_upgrade_required",
        "required_protocol": 2,
        "negotiated_protocol": 1,
    }


def test_matched_session_makes_exactly_one_renderer_request(monkeypatch):
    sid = "matched-ui"
    calls = []
    server._sessions[sid] = {"source": "desktop", "desktop_ui_protocol": 2}
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
    assert calls == [(("preview.read.request", sid, {}), {"timeout": 45})]


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
    finally:
        desktop_ui.set_protocol_resolver(None)
        desktop_ui.set_emitter(None)
        server._sessions.pop(sid, None)

    assert opened["status"] == "dispatched"
    assert read["title"] == "Example Domain"
    assert elements["elements"] == [{"ref": "lnk-more", "role": "link"}]
    assert emitted == [
        (sid, "preview.open", {"url": "https://example.com", "label": ""})
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
        assert server._sessions[sid]["desktop_ui_protocol"] == 0
        raw = server._agent_cbs(sid)["read_terminal_callback"]()
        assert calls == []
        assert json.loads(raw)["code"] == "desktop_ui_unavailable"
    finally:
        server._sessions.pop(sid, None)


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
    import tools.mcp_tool as mcp_tool

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
    monkeypatch.setattr(mcp_tool, "shutdown_mcp_servers", lambda: None)
    monkeypatch.setattr(mcp_tool, "discover_mcp_tools", lambda: None)
    monkeypatch.setattr(server, "_compute_mcp_rev", lambda: "stable")
    monkeypatch.setattr(server, "_emit", lambda *_args: None)
    monkeypatch.setattr(server, "_session_info", lambda *_args: {})

    def fake_load(platform=None, protocol=None):
        loaded.append((platform, protocol))
        return ["desktop_ui", "desktop_ui_v2"]

    monkeypatch.setattr(server, "_load_enabled_toolsets", fake_load)
    monkeypatch.setattr(
        mcp_tool,
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
