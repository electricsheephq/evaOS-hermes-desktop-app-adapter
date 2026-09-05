"""Failing-first behavioral contract for the R3.1 Desktop UI protocol.

This file deliberately exercises the public tool registry, the real preview/tip
handlers, and the gateway callback bridge.  It does not inspect source text or
invent a model/renderer implementation.  The current pinned main is expected
to fail until the runtime port adds protocol-3 negotiation and its guards.
"""

import json

import pytest

import model_tools
import tui_gateway.server as server
from tools import desktop_ui, preview_tool  # noqa: F401
# Import the real modules so their registry declarations are present.  These
# are registration imports, not local fakes or alternate implementations.
from tools import (  # noqa: F401
    annotate_preview_tool,
    apply_layout_tool,
    close_terminal_tool,
    drive_preview_tool,
    focus_pane_tool,
    read_terminal_tool,
    read_window_tool,
    react_to_message_tool,
    setup_mcp_tool,
    tip_tool,
    tour_tool,
)
from tools.read_preview_tool import read_preview_tool
from tools.registry import registry
from tools.tool_search import is_deferrable_tool_name
from toolsets import resolve_toolset


# The protocol is an authorization-independent capability declaration.  These
# are tool names, not renderer events: one consolidated preview tool appears on
# protocol 1, while its read/close actions are guarded at protocol 2.
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
PROTOCOL_3_TOOLS = {"show_tip"}


# Every renderer event reachable from the desktop_ui surface must be listed
# here with the tool/action identity used for errors and lifecycle receipts.
# The responder level is the minimum client protocol, not an authorization grant.
EXPECTED_EVENT_REQUIREMENTS = {
    "terminal.read.request": (1, "read_terminal"),
    "terminal.close": (1, "close_terminal"),
    "preview.open": (1, "desktop_preview.open"),
    "pane.reveal": (1, "focus_pane"),
    "message.reaction": (1, "react_to_message"),
    "preview.read.request": (2, "desktop_preview.read"),
    "preview.close": (2, "desktop_preview.close"),
    "preview.act.request": (2, "drive_preview"),
    "window.read.request": (2, "read_window_below"),
    "mcp.setup.request": (2, "setup_mcp"),
    "tour.request": (2, "gui_tour"),
    "layout.apply": (2, "apply_layout"),
    "tip.show": (3, "show_tip"),
}


@pytest.fixture(autouse=True)
def _reset_desktop_bridge():
    """Do not leak synthetic emitters or protocol resolvers between cases."""
    desktop_ui.set_emitter(None)
    resolver = getattr(desktop_ui, "set_protocol_resolver", None)
    if resolver is not None:
        resolver(None)
    yield
    desktop_ui.set_emitter(None)
    if resolver is not None:
        resolver(None)


def _surface_tool_names(protocol):
    names = set()
    for toolset in server._gui_surface_toolsets("desktop", desktop_ui_protocol=protocol):
        names.update(resolve_toolset(toolset))
    return names


def _put_session(monkeypatch, sid, protocol):
    server._sessions[sid] = {
        "source": "desktop",
        "desktop_ui_protocol": protocol,
    }
    monkeypatch.setattr(
        desktop_ui,
        "get_session_env",
        lambda name, default="": sid if name == "HERMES_UI_SESSION_ID" else default,
    )


def test_protocol_negotiation_is_numeric_source_bound_and_clamped():
    assert server._negotiate_desktop_ui_protocol("desktop", None) == 1
    assert server._negotiate_desktop_ui_protocol("desktop", 1) == 1
    assert server._negotiate_desktop_ui_protocol("desktop", 2) == 2
    assert server._negotiate_desktop_ui_protocol("desktop", 3) == 3
    assert server._negotiate_desktop_ui_protocol("desktop", 99) == 3
    assert server._negotiate_desktop_ui_protocol("desktop", True) == 1
    assert server._negotiate_desktop_ui_protocol("tui", 3) == 0


def test_surface_filtering_keeps_actions_on_their_protocol_surface():
    # No capability declaration is authorization: the source/session guard is
    # exercised separately below.  This assertion only proves what is exposed.
    assert _surface_tool_names(1) == PROTOCOL_1_TOOLS
    assert _surface_tool_names(2) == PROTOCOL_1_TOOLS | PROTOCOL_2_TOOLS
    assert _surface_tool_names(3) == PROTOCOL_1_TOOLS | PROTOCOL_2_TOOLS | PROTOCOL_3_TOOLS
    assert _surface_tool_names(3).isdisjoint({"open_preview", "close_preview", "read_preview", "tour", "tip"})


def test_event_requirement_table_is_closed_and_protocol3_is_tip_only():
    assert server._DESKTOP_UI_EVENT_REQUIREMENTS == EXPECTED_EVENT_REQUIREMENTS

    # Unknown renderer actions fail closed; they are not silently treated as
    # protocol-current merely because the client negotiated a high number.
    sid = "synthetic-r31-unknown"
    server._sessions[sid] = {"source": "desktop", "desktop_ui_protocol": 3}
    try:
        raw = server._desktop_ui_emitter_protocol_error(sid, "renderer.unknown")
    finally:
        server._sessions.pop(sid, None)
    assert raw is not None
    assert json.loads(raw)["code"] == "desktop_ui_action_unavailable"


def test_protocol1_preview_open_dispatches_but_read_never_waits(monkeypatch):
    sid = "synthetic-r31-p1"
    _put_session(monkeypatch, sid, 1)
    emitted = []
    blocked = []
    desktop_ui.set_protocol_resolver(server._desktop_ui_emitter_protocol_error)
    desktop_ui.set_emitter(lambda current_sid, event, payload: emitted.append((current_sid, event, payload)))
    monkeypatch.setattr(
        server,
        "_block",
        lambda *args, **kwargs: blocked.append((args, kwargs)) or json.dumps({"text": "must not wait"}),
    )

    opened = json.loads(registry.dispatch("desktop_preview", {
        "action": "open", "url": "https://example.invalid",
    }))
    read = json.loads(read_preview_tool(callback=server._agent_cbs(sid)["read_preview_callback"]))

    assert opened["success"] is True
    assert [event for _sid, event, _payload in emitted] == ["preview.open"]
    assert read["code"] == "desktop_ui_protocol_upgrade_required"
    assert blocked == []
    server._sessions.pop(sid, None)


def test_protocol2_preview_read_close_are_allowed_but_tip_is_blocked(monkeypatch):
    sid = "synthetic-r31-p2"
    _put_session(monkeypatch, sid, 2)
    emitted = []
    blocked = []
    desktop_ui.set_protocol_resolver(server._desktop_ui_emitter_protocol_error)
    desktop_ui.set_emitter(lambda current_sid, event, payload: emitted.append((current_sid, event, payload)))
    monkeypatch.setattr(
        server,
        "_block",
        lambda *args, **kwargs: blocked.append((args, kwargs)) or json.dumps({"title": "Synthetic"}),
    )

    closed = json.loads(registry.dispatch("desktop_preview", {"action": "close"}))
    read = json.loads(read_preview_tool(callback=server._agent_cbs(sid)["read_preview_callback"]))
    tip = json.loads(registry.dispatch("show_tip", {
        "text": "Synthetic tip", "selector": "#synthetic",
    }))

    assert closed["success"] is True
    assert read == {"title": "Synthetic"}
    assert tip["code"] == "desktop_ui_protocol_upgrade_required"
    assert [event for _sid, event, _payload in emitted] == ["preview.close"]
    assert len(blocked) == 1
    assert blocked[0][0][0] == "preview.read.request"

    server._sessions.pop(sid, None)


def test_protocol3_tip_emits_new_responder(monkeypatch):
    sid = "synthetic-r31-p3"
    _put_session(monkeypatch, sid, 3)
    emitted = []
    desktop_ui.set_protocol_resolver(server._desktop_ui_emitter_protocol_error)
    desktop_ui.set_emitter(lambda current_sid, event, payload: emitted.append((current_sid, event, payload)))

    result = json.loads(registry.dispatch("show_tip", {
        "text": "Synthetic tip", "selector": "#synthetic",
    }))

    assert result == {"success": True, "selector": "#synthetic"}
    assert emitted == [
        (sid, "tip.show", {"selector": "#synthetic", "text": "Synthetic tip"}),
    ]
    server._sessions.pop(sid, None)


def test_fire_and_forget_rechecks_attachment_after_a_lifecycle_downgrade(monkeypatch):
    sid = "synthetic-r31-rebind"
    _put_session(monkeypatch, sid, 3)
    emitted = []
    desktop_ui.set_emitter(lambda current_sid, event, payload: emitted.append((current_sid, event, payload)))
    original = server._desktop_ui_emitter_protocol_error
    first_check = True

    def downgrade_before_emit(current_sid, event):
        nonlocal first_check
        if first_check:
            first_check = False
            server._sessions[sid]["desktop_ui_protocol"] = 2
        return original(current_sid, event)

    desktop_ui.set_protocol_resolver(downgrade_before_emit)
    result = json.loads(registry.dispatch("show_tip", {
        "text": "Synthetic tip", "selector": "#synthetic",
    }))

    assert result["code"] == "desktop_ui_protocol_upgrade_required"
    assert emitted == []
    server._sessions.pop(sid, None)


def test_alias_direct_dispatch_and_tool_search_keep_canonical_gui_names(monkeypatch):
    assert model_tools._LEGACY_TOOL_ALIASES["tour"] == "gui_tour"
    assert model_tools._LEGACY_TOOL_ALIASES["tip"] == "show_tip"
    assert is_deferrable_tool_name("desktop_preview", frozenset()) is False
    assert is_deferrable_tool_name("gui_tour", frozenset()) is False
    assert is_deferrable_tool_name("show_tip", frozenset()) is False

    sid = "synthetic-r31-dispatch"
    _put_session(monkeypatch, sid, 2)
    emitted = []
    desktop_ui.set_protocol_resolver(server._desktop_ui_emitter_protocol_error)
    desktop_ui.set_emitter(lambda current_sid, event, payload: emitted.append((current_sid, event, payload)))

    # The legacy direct alias reaches the canonical show_tip handler, whose
    # protocol guard must stop before the renderer emitter on a protocol-2
    # client.  Tool Search's direct-surface rule is asserted above as well.
    result = json.loads(model_tools.handle_function_call(
        "tip",
        {"text": "Synthetic tip", "selector": "#synthetic"},
        session_id=sid,
        skip_pre_tool_call_hook=True,
        skip_tool_request_middleware=True,
        skip_tool_execution_middleware=True,
    ))

    assert result["code"] == "desktop_ui_protocol_upgrade_required"
    assert emitted == []
    server._sessions.pop(sid, None)


def test_registry_contract_exposes_only_canonical_gui_tools():
    # Real registry entries, not source-regex snapshots, are the public surface
    # consumed by model_tools and the agent's inline executor.
    for name in PROTOCOL_1_TOOLS | PROTOCOL_2_TOOLS | PROTOCOL_3_TOOLS:
        assert registry.get_entry(name) is not None
    for old_name in ("open_preview", "close_preview", "read_preview", "tour", "tip"):
        assert registry.get_entry(old_name) is None
