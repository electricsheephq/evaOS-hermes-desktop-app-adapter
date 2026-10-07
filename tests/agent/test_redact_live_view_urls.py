"""Live-view handoffs survive assistant storage without exempting other secrets."""

from types import SimpleNamespace

import pytest

from agent import redact
from agent.chat_completion_helpers import _assistant_content_for_storage


# header is base64url {"alg":"A256KW","enc":"A256GCM"}, the shape Browserbase issues
JWE = ".".join(("eyJhbGciOiJBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIn0", "B" * 54, "C" * 16, "D" * 146, "E" * 22))
JWT = "eyJ" + "F" * 40 + "." + "G" * 40 + "." + "H" * 40
URL = (
    "https://www.browserbase.com/devtools-fullscreen/inspector.html"
    "?wss=connect.browserbase.com/debug/00000000-0000-4000-8000-000000000000"
    "/devtools/page/DA534967A0C5A3A3BA4B6FD253E65FCF?t=" + JWE + "&debug=true"
)


@pytest.fixture(autouse=True)
def redaction_on(monkeypatch):
    monkeypatch.setattr(redact, "_REDACT_ENABLED", True)


def store(text):
    agent = SimpleNamespace(_strip_think_blocks=lambda text: text)
    return _assistant_content_for_storage(agent, SimpleNamespace(content=text))


@pytest.mark.parametrize("text", [
    f"Open {URL} then use {JWT}",
    f"[Open live view]({URL}) then use {JWT}",
    f"Open {URL}. Then use {JWT}",
    f"Open {URL} and {URL.replace('DA534967A0C5A3A3BA4B6FD253E65FCF', '0123456789ABCDEF0123456789ABCDEF')} then use {JWT}",
])
def test_assistant_storage_preserves_handoffs_and_masks_other_jwts(text):
    expected = text.replace(JWT, redact.redact_sensitive_text(JWT, force=True))
    assert store(text) == expected


@pytest.mark.parametrize("kwargs", [{}, {"force": True}])
def test_default_and_forced_redaction_still_mask_live_view_tokens(kwargs):
    assert JWE not in redact.redact_sensitive_text(URL, **kwargs)


@pytest.mark.parametrize("url", [
    URL.replace("https://", "http://"),
    URL.replace("www.browserbase.com", "www.browserbase.com.evil.example"),
    URL.replace("www.browserbase.com", "evilbrowserbase.com"),
    URL.replace("www.browserbase.com", "browserbase.com@evil.example"),
    URL.replace("?wss=", "?other=1&wss="),
    URL.replace("connect.browserbase.com/debug/", "connect.browserbase.com/other/"),
])
def test_lookalikes_are_not_protected(url):
    assert JWE not in redact.redact_sensitive_text(url, preserve_live_view_urls=True)


@pytest.mark.parametrize("ending", list(")] >\"'`<".replace(" ", "")) + [".", ",", ";", ":", "!", "?"])
def test_protected_span_leaves_delimiters_and_other_secrets_outside(ending):
    text = URL + ending + " " + JWT
    assert redact.redact_sensitive_text(text, preserve_live_view_urls=True) == (
        URL + ending + " " + redact.redact_sensitive_text(JWT, force=True)
    )


def test_host_case_is_accepted():
    url = URL.replace("www.browserbase.com", "WWW.BROWSERBASE.COM")
    assert store(url) == url


def test_redaction_off_remains_noop(monkeypatch):
    monkeypatch.setattr(redact, "_REDACT_ENABLED", False)
    text = URL + " " + JWT
    assert store(text) == text
    assert redact.redact_sensitive_text(text, preserve_live_view_urls=True) == text


def test_interim_commentary_preserves_live_view_url_and_masks_other_jwt():
    from agent.history_commentary import visible_commentary

    text = f"Open {URL} then reply. {JWT}"
    out = visible_commentary(text, strip_thinking=lambda value: value)
    assert URL in out
    assert JWT not in out


@pytest.mark.parametrize("glue", [";", ",", "|", "#"])
def test_secret_glued_to_live_view_url_is_still_masked(glue):
    secret = "sk-ant-api03-" + "x" * 90
    out = redact.redact_sensitive_text(URL + glue + secret, preserve_live_view_urls=True)
    assert URL in out
    assert secret not in out


SECRET = "sk-ant-api03-" + "x" * 90


# ``-`` / ``_`` glue is left out: the baseline redactor (no opt-in) also misses a prefix secret glued that way.
@pytest.mark.parametrize("suffix", [".", "&x=", "&password=", "&debug=true&x=", "?x=", ".x&y="])
@pytest.mark.parametrize("forced", [False, True])
def test_secret_appended_inside_url_shape_is_still_masked(suffix, forced):
    text = URL + suffix + SECRET
    if forced:
        out = redact.redact_for_egress(text, preserve_live_view_urls=True)
    else:
        out = redact.redact_sensitive_text(text, preserve_live_view_urls=True)
    assert SECRET not in out


def test_vault_value_inside_preserved_span_is_scrubbed(monkeypatch):
    vault = "syntheticVaultPassword00991"
    monkeypatch.setattr(redact, "redact_registered_vault_values", lambda t: t.replace(vault, "[vault]"))
    for text in (URL.replace("DA534967A0C5A3A3BA4B6FD253E65FCF", vault), URL + "&x=" + vault):
        assert vault not in redact.redact_sensitive_text(text, preserve_live_view_urls=True)
        assert vault not in redact.redact_for_egress(text, preserve_live_view_urls=True)


P = URL.split("?t=")[0]


@pytest.mark.parametrize("text", [
    URL.replace("DA534967A0C5A3A3BA4B6FD253E65FCF", SECRET),
    URL.replace("00000000-0000-4000-8000-000000000000", SECRET),
    P + "?t=" + SECRET,
    P + "?t=" + JWT + "." + SECRET,
    P + "?t=" + SECRET[:20] + "\r" + SECRET[20:],
    P + "?t=" + SECRET[:20] + "\n" + SECRET[20:],
    P + "?t=" + SECRET[:20] + "\u200b" + SECRET[20:],
])
def test_secret_in_any_url_field_is_still_masked(text):
    assert SECRET not in redact.redact_sensitive_text(text, preserve_live_view_urls=True)
    assert SECRET not in redact.redact_for_egress(text, preserve_live_view_urls=True)
    assert SECRET[20:] not in redact.redact_for_egress(text, preserve_live_view_urls=True) or SECRET[:20] not in redact.redact_for_egress(text, preserve_live_view_urls=True)


def test_assignment_context_spanning_a_live_view_url_is_still_masked():
    import json

    text = json.dumps({"password": "opaqueSyntheticSecret " + URL})
    for out in (redact.redact_sensitive_text(text, preserve_live_view_urls=True),
                redact.redact_for_egress(text, preserve_live_view_urls=True)):
        assert "opaqueSyntheticSecret" not in out


def test_vault_value_in_token_header_or_across_segments_is_scrubbed(monkeypatch):
    vaults = ("VaultSecretX9", "VaultPart.SecondPart")
    monkeypatch.setattr(redact, "redact_registered_vault_values",
                        lambda t: t.replace(vaults[0], "[vault]").replace(vaults[1], "[vault]"))
    head, rest = JWE.split(".", 1)
    cases = (
        (vaults[0], head + vaults[0] + "." + rest),                                      # inside the header
        (vaults[1], head + "." + vaults[1] + "." + "C" * 40 + "." + "E" * 21),           # across two segments
    )
    for vault, token in cases:
        text = URL.replace(JWE, token)
        assert vault not in redact.redact_sensitive_text(text, preserve_live_view_urls=True)
        assert vault not in redact.redact_for_egress(text, preserve_live_view_urls=True)


# a signed JWT (no ``enc``), a JWT with extra segments, or a JWE-shaped token without a JWE header never qualifies
@pytest.mark.parametrize("token", [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." + "S" * 40 + "." + "T" * 43,
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." + "S" * 40 + "." + "T" * 43 + ".U.V",
    "eyJ" + "A" * 40 + "." + "B" * 54 + "." + "C" * 16 + "." + "D" * 146 + "." + "E" * 22,
])
def test_only_encrypted_viewer_tokens_are_preserved(token):
    text = URL.replace(JWE, token)
    for out in (redact.redact_sensitive_text(text, preserve_live_view_urls=True),
                redact.redact_for_egress(text, preserve_live_view_urls=True)):
        assert token not in out
