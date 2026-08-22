"""Browserbase Live View retrieval stays additive and credential-safe."""

from __future__ import annotations

import os
from typing import Any

import pytest

from plugins.browser.browserbase import provider as browserbase_provider


class _Response:
    def __init__(
        self,
        *,
        status_code: int,
        payload: dict[str, Any],
        text: str = "",
    ) -> None:
        self.status_code = status_code
        self._payload = payload
        self.text = text

    @property
    def ok(self) -> bool:
        return 200 <= self.status_code < 300

    def json(self) -> dict[str, Any]:
        return self._payload


def _configure_provider(monkeypatch) -> browserbase_provider.BrowserbaseBrowserProvider:
    secrets = {
        "BROWSERBASE_API_KEY": "bb_test_secret",
        "BROWSERBASE_PROJECT_ID": "project_test",
    }
    monkeypatch.setattr(
        browserbase_provider,
        "get_secret",
        lambda key: secrets.get(key),
    )
    monkeypatch.setenv("BROWSERBASE_PROXIES", "false")
    monkeypatch.setenv("BROWSERBASE_KEEP_ALIVE", "false")
    return browserbase_provider.BrowserbaseBrowserProvider()


def test_create_session_returns_official_fullscreen_live_view(monkeypatch):
    provider = _configure_provider(monkeypatch)
    calls: list[tuple[str, str, dict[str, Any]]] = []

    def fake_post(url, *, headers, json, timeout):
        calls.append(("POST", url, {"headers": headers, "json": json, "timeout": timeout}))
        return _Response(
            status_code=201,
            payload={
                "id": "session_test",
                "connectUrl": "wss://connect.browserbase.test/session",
            },
        )

    def fake_get(url, *, headers, timeout):
        calls.append(("GET", url, {"headers": headers, "timeout": timeout}))
        return _Response(
            status_code=200,
            payload={
                "debuggerFullscreenUrl": "https://live.browserbase.test/session",
                "debuggerUrl": "https://debug.browserbase.test/session",
                "wsUrl": "wss://debug.browserbase.test/session",
            },
        )

    monkeypatch.setattr(browserbase_provider.requests, "post", fake_post)
    monkeypatch.setattr(browserbase_provider.requests, "get", fake_get)

    session = provider.create_session("checkout")

    assert session["user_handoff"] == {
        "url": "https://live.browserbase.test/session"
    }
    assert session["cdp_url"] == "wss://connect.browserbase.test/session"
    assert calls[1][0:2] == (
        "GET",
        "https://api.browserbase.com/v1/sessions/session_test/debug",
    )
    assert calls[1][2]["headers"] == {"X-BB-API-Key": "bb_test_secret"}


def test_live_view_failure_does_not_destroy_created_browser_session(monkeypatch):
    provider = _configure_provider(monkeypatch)

    monkeypatch.setattr(
        browserbase_provider.requests,
        "post",
        lambda *args, **kwargs: _Response(
            status_code=201,
            payload={
                "id": "session_test",
                "connectUrl": "wss://connect.browserbase.test/session",
            },
        ),
    )
    monkeypatch.setattr(
        browserbase_provider.requests,
        "get",
        lambda *args, **kwargs: _Response(
            status_code=503,
            payload={},
            text="provider response that must not enter the session result",
        ),
    )

    session = provider.create_session("checkout")

    assert session["bb_session_id"] == "session_test"
    assert session["cdp_url"] == "wss://connect.browserbase.test/session"
    assert "user_handoff" not in session
    assert "provider response" not in repr(session)


def test_non_https_live_view_url_is_ignored(monkeypatch):
    provider = _configure_provider(monkeypatch)

    monkeypatch.setattr(
        browserbase_provider.requests,
        "post",
        lambda *args, **kwargs: _Response(
            status_code=201,
            payload={
                "id": "session_test",
                "connectUrl": "wss://connect.browserbase.test/session",
            },
        ),
    )
    monkeypatch.setattr(
        browserbase_provider.requests,
        "get",
        lambda *args, **kwargs: _Response(
            status_code=200,
            payload={"debuggerFullscreenUrl": "javascript:alert(1)"},
        ),
    )

    session = provider.create_session("checkout")

    assert "user_handoff" not in session


def test_malformed_https_live_view_url_is_ignored(monkeypatch):
    provider = _configure_provider(monkeypatch)

    monkeypatch.setattr(
        browserbase_provider.requests,
        "post",
        lambda *args, **kwargs: _Response(
            status_code=201,
            payload={
                "id": "session_test",
                "connectUrl": "wss://connect.browserbase.test/session",
            },
        ),
    )
    monkeypatch.setattr(
        browserbase_provider.requests,
        "get",
        lambda *args, **kwargs: _Response(
            status_code=200,
            payload={"debuggerFullscreenUrl": "https://[::1"},
        ),
    )

    session = provider.create_session("checkout")

    assert session["bb_session_id"] == "session_test"
    assert session["cdp_url"] == "wss://connect.browserbase.test/session"
    assert "user_handoff" not in session


def test_real_browserbase_live_view_contract_when_credentials_are_opted_in():
    """Protected vendor canary; ordinary CI skips without explicit secrets."""
    if not (
        os.getenv("BROWSERBASE_API_KEY")
        and os.getenv("BROWSERBASE_PROJECT_ID")
    ):
        pytest.skip("Browserbase live canary credentials are not configured")

    provider = browserbase_provider.BrowserbaseBrowserProvider()
    session = None
    try:
        session = provider.create_session("live_view_contract_canary")
        handoff = session.get("user_handoff")
        assert isinstance(handoff, dict)
        assert provider._valid_live_view_url(handoff.get("url")) == handoff["url"]
    finally:
        if isinstance(session, dict) and session.get("bb_session_id"):
            provider.close_session(str(session["bb_session_id"]))
