"""Tests for cloud browser provider runtime fallback to local Chromium.

Covers the fallback logic in _get_session_info() when a cloud provider
is configured but fails at runtime (issue #10883).
"""
import logging
from unittest.mock import Mock

import pytest

import tools.browser_tool as browser_tool
from tools import browser_tool_session as bt_session
from tools import browser_tool_cloud as bt_cloud


def _reset_session_state(monkeypatch):
    """Clear caches so each test starts fresh."""
    monkeypatch.setattr(browser_tool, "_active_sessions", {})
    monkeypatch.setattr(browser_tool, "_cached_cloud_provider", None)
    monkeypatch.setattr(browser_tool, "_cloud_provider_resolved", False)
    monkeypatch.setattr("tools.browser_tool_lifecycle._start_browser_cleanup_thread", lambda: None)
    monkeypatch.setattr("tools.browser_tool_lifecycle._update_session_activity", lambda t: None)


class TestCloudProviderRuntimeFallback:
    """Tests for _get_session_info cloud → local fallback."""

    def test_cloud_failure_falls_back_to_local(self, monkeypatch):
        """When cloud provider.create_session raises, fall back to local."""
        _reset_session_state(monkeypatch)

        provider = Mock()
        provider.create_session.side_effect = RuntimeError("401 Unauthorized")
        monkeypatch.setattr(bt_cloud, "_get_cloud_provider", lambda: provider)
        monkeypatch.setattr("tools.browser_tool_cdp._get_cdp_override", lambda: None)

        session = bt_session._get_session_info("task-1")

        assert session["fallback_from_cloud"] is True
        assert "401 Unauthorized" in session["fallback_reason"]
        assert session["fallback_provider"] == "Mock"
        assert session["features"]["local"] is True
        assert session["cdp_url"] is None

    def test_capacity_error_is_retryable_instead_of_cached_as_local(self, monkeypatch):
        """Capacity must escape so the next tool retry attempts cloud creation again."""
        from plugins.browser._common import CloudBrowserAPIError

        _reset_session_state(monkeypatch)
        provider = Mock()
        provider.create_session.side_effect = CloudBrowserAPIError(
            "Failed to create Browserbase session: HTTP 429 (code: browser_capacity)",
            status_code=429,
            code="browser_capacity",
        )
        monkeypatch.setattr(bt_cloud, "_get_cloud_provider", lambda: provider)
        monkeypatch.setattr("tools.browser_tool_cdp._get_cdp_override", lambda: None)

        with pytest.raises(CloudBrowserAPIError) as raised:
            bt_session._get_session_info("task-capacity")

        assert raised.value.code == "browser_capacity"
        assert "task-capacity" not in browser_tool._active_sessions

    def test_provider_rate_limit_falls_back_to_local(self, monkeypatch):
        """A provider-specific 429 code is not relabeled as browser capacity."""
        from plugins.browser._common import CloudBrowserAPIError

        _reset_session_state(monkeypatch)
        provider = Mock()
        provider.create_session.side_effect = CloudBrowserAPIError(
            "Failed to create Browserbase session: HTTP 429 (code: rate_limited)",
            status_code=429,
            code="rate_limited",
        )
        monkeypatch.setattr(bt_cloud, "_get_cloud_provider", lambda: provider)
        monkeypatch.setattr("tools.browser_tool_cdp._get_cdp_override", lambda: None)

        session = bt_session._get_session_info("task-rate-limited")

        assert session["fallback_from_cloud"] is True
        assert session["fallback_error_code"] == "rate_limited"


    def test_no_provider_uses_local_directly(self, monkeypatch):
        """When no cloud provider is configured, local mode is used with no fallback markers."""
        _reset_session_state(monkeypatch)

        monkeypatch.setattr(bt_cloud, "_get_cloud_provider", lambda: None)
        monkeypatch.setattr("tools.browser_tool_cdp._get_cdp_override", lambda: None)

        session = bt_session._get_session_info("task-4")

        assert session["features"]["local"] is True
        assert "fallback_from_cloud" not in session


    def test_cloud_returns_invalid_session_triggers_fallback(self, monkeypatch):
        """Cloud provider returning None or empty dict triggers fallback."""
        _reset_session_state(monkeypatch)

        provider = Mock()
        provider.create_session.return_value = None
        monkeypatch.setattr(bt_cloud, "_get_cloud_provider", lambda: provider)
        monkeypatch.setattr("tools.browser_tool_cdp._get_cdp_override", lambda: None)

        session = bt_session._get_session_info("task-7")

        assert session["fallback_from_cloud"] is True
        assert "invalid session" in session["fallback_reason"]
