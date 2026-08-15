"""Fail-closed redaction for untrusted external error detail."""

import pytest

from agent import redact as redact_module
from agent.redact import redact_untrusted_error_detail


@pytest.mark.parametrize(
    "raw",
    [
        '{"token":"Bearer synthetic-token-value"}',
        '"{\\"token\\":\\"Bearer synthetic-token-value\\"}"',
        '{"Authorization":"Bearer synthetic-bearer-value"}',
        '{"account_id":"synthetic-account-value"}',
        '{"outer":[{"profile_id":"synthetic-profile-value"}]}',
        '{"external_id":"synthetic-external-value"}',
        '{"project_id":"synthetic-project-value"}',
        r'{"t\u006fken":"synthetic-escaped-key-value"}',
        "token=synthetic-token-value",
        "password=synthetic-password-value",
        "account_id=synthetic-account-value",
        "Authorization: Bearer synthetic-bearer-value",
        "Cookie: session=synthetic-cookie-value",
    ],
)
def test_sensitive_error_detail_is_removed_entirely(raw):
    assert redact_untrusted_error_detail(raw) == "[redacted]"


def test_known_secret_is_removed_even_without_a_field_name():
    raw = "broker rejected synthetic-known-secret"
    assert (
        redact_untrusted_error_detail(
            raw,
            known_secrets=("synthetic-known-secret",),
        )
        == "[redacted]"
    )


def test_safe_error_detail_is_preserved_and_bounded():
    assert redact_untrusted_error_detail("Pipedream grant is required") == (
        "Pipedream grant is required"
    )
    assert redact_untrusted_error_detail("abcdefgh", limit=4) == "abcd"


def test_redactor_failure_does_not_return_raw_detail(monkeypatch):
    monkeypatch.setattr(
        redact_module,
        "redact_sensitive_text",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    assert redact_untrusted_error_detail("safe-looking detail") == "[redacted]"
