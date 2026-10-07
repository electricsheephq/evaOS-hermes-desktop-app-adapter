"""Final chat handoffs preserve viewer links without weakening other egress."""

import pytest

from agent import redact
from gateway.config import Platform
from gateway.run import _prepare_gateway_status_message, _sanitize_gateway_final_response


JWE = ".".join(("eyJ" + "A" * 57, "B" * 60, "C" * 40, "D" * 100, "E" * 21))
JWT = "eyJ" + "F" * 40 + "." + "G" * 40 + "." + "H" * 40
URL = (
    "https://www.browserbase.com/devtools-fullscreen/inspector.html"
    "?wss=connect.browserbase.com/debug/00000000-0000-4000-8000-000000000000"
    "/devtools/page/DA534967A0C5A3A3BA4B6FD253E65FCF?t=" + JWE + "&debug=true"
)


@pytest.mark.parametrize("enabled", [True, False])
def test_final_reply_preserves_live_view_and_masks_other_secrets(monkeypatch, enabled):
    monkeypatch.setattr(redact, "_REDACT_ENABLED", enabled)
    secrets = f"JWT {JWT}; Bearer {'Z' * 40}"
    text = f"[Open live view]({URL}). {secrets}"
    assert _sanitize_gateway_final_response(Platform.TELEGRAM, text) == (
        f"[Open live view]({URL}). {redact.redact_for_egress(secrets)}"
    )


@pytest.mark.parametrize("url", [
    URL.replace("https://", "http://"),
    URL.replace("www.browserbase.com", "www.browserbase.com.evil.example"),
    URL.replace("www.browserbase.com", "evilbrowserbase.com"),
    URL.replace("www.browserbase.com", "browserbase.com@evil.example"),
    URL.replace("?wss=", "?other=1&wss="),
    URL.replace("connect.browserbase.com/debug/", "connect.browserbase.com/other/"),
])
def test_final_reply_masks_lookalikes(url):
    assert JWE not in _sanitize_gateway_final_response(Platform.TELEGRAM, url)


def test_status_and_default_egress_still_mask_live_view():
    text = f"Open {URL}"
    assert JWE not in redact.redact_for_egress(text)
    assert JWE not in _prepare_gateway_status_message(Platform.TELEGRAM, "lifecycle", text)


@pytest.mark.parametrize("viewer", [URL])
def test_live_view_does_not_overlap_bearer_sweep(viewer):
    text = f"Bearer {viewer} Bearer {'Z' * 40}"
    assert redact.redact_for_egress(text, preserve_live_view_urls=True) == (
        f"Bearer {viewer} Bearer [redacted]"
    )


def test_opted_in_egress_fails_closed(monkeypatch):
    def fail(*args, **kwargs):
        raise RuntimeError("synthetic redactor failure")
    monkeypatch.setattr(redact, "redact_sensitive_text", fail)
    assert redact.redact_for_egress(URL, preserve_live_view_urls=True) == redact.REDACTION_UNAVAILABLE


def test_provider_error_shaped_reply_still_maps_to_safe_category():
    text = f"API call failed: HTTP 401 Unauthorized — Bearer {'Z' * 40}"
    result = _sanitize_gateway_final_response(Platform.TELEGRAM, text)
    assert "sign-in" in result.lower() and "/login" in result
    assert "HTTP 401" not in result and "Z" * 40 not in result



def test_bracketed_viewer_after_bearer_fails_safe():
    text = f"Bearer [{URL}] Bearer {'Z' * 40}"
    out = redact.redact_for_egress(text, preserve_live_view_urls=True)
    assert "Z" * 40 not in out
