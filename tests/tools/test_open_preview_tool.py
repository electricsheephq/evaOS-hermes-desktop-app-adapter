"""Tests for the GUI-surface ``open_preview`` tool."""

import json

import pytest

from tools import desktop_ui, open_preview_tool as op


@pytest.fixture(autouse=True)
def _reset_emitter():
    """Each test controls the emitter; never leak one across tests."""
    desktop_ui.set_emitter(None)
    desktop_ui.set_protocol_resolver(None)
    yield
    desktop_ui.set_emitter(None)
    desktop_ui.set_protocol_resolver(None)




def test_emitter_failure_is_reported():
    def _boom(*_a):
        raise RuntimeError("no window")

    desktop_ui.set_emitter(_boom)
    assert "no window" in json.loads(op.open_preview_tool("https://x.example"))["error"]


def test_success_is_explicitly_dispatch_only():
    desktop_ui.set_emitter(lambda _sid, _event, _payload: None)

    out = json.loads(op.open_preview_tool("https://example.com"))

    assert out == {
        "success": True,
        "status": "dispatched",
        "url": "https://example.com",
        "label": "",
    }
