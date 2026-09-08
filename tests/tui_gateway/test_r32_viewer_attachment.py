"""Upstream's shared rebind helper must retain managed viewer capability ownership."""
import threading


def test_rebind_retains_each_viewers_negotiated_source_and_protocol(monkeypatch):
    from tui_gateway import server

    first, second = object(), object()
    monkeypatch.setattr(server, '_cancel_ws_orphan_reap', lambda *_args: None)
    session = {'history_lock': threading.Lock(), 'source': 'desktop', 'desktop_ui_protocol': 3}
    server._bind_session_attachment(session, 'desktop', 3, transport=first)
    server._bind_session_attachment(session, 'desktop', 1, transport=second)
    with session['history_lock']:
        server._rebind_live_transport('fixture', session, first)
    assert session['transport'] is first
    assert session['viewers'][first]['source'] == 'desktop'
    assert session['viewers'][first]['desktop_ui_protocol'] == 3
    assert session['viewers'][second]['desktop_ui_protocol'] == 1
