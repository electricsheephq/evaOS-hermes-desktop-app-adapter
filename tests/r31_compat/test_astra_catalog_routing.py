"""Offline catalog/transport proof; no provider entitlement or inference claim."""

import pytest

from hermes_cli.codex_models import _finalize_codex_models, _ranked_slugs
from hermes_cli.models_catalog_static import OPENROUTER_MODELS
from hermes_cli.runtime_provider import _effective_model, _fallback_api_mode


def test_selected_astra_catalog_variants_keep_their_route_and_slug():
    # Exercise current catalog choices without freezing its count or full list.
    variants = [model for model, _ in OPENROUTER_MODELS if model.startswith("openai/gpt-6-astra")]
    assert variants, "the pinned target must offer the planned Astra choice"
    for selected in variants:
        effective = _effective_model({"default": "synthetic-prior-model"}, selected)
        assert effective == selected
        assert _fallback_api_mode("openrouter", "https://openrouter.ai/api/v1", effective) == "chat_completions"


def test_account_catalog_retains_astra_without_synthesizing_entitlement():
    # This is a synthetic catalog response, not a read of a real account.
    entries = [
        {"slug": "gpt-6-astra", "priority": 1, "supported_in_api": False},
        {"slug": "gpt-6-astra", "priority": 2},
        {"slug": "synthetic-hidden", "visibility": "hidden"},
    ]
    models = _finalize_codex_models(_ranked_slugs(entries))
    assert models == ["gpt-6-astra"]
    assert "gpt-6-astra" not in _finalize_codex_models([])


@pytest.mark.parametrize(
    "provider,endpoint,model,expected",
    [
        ("openai", "https://api.openai.com/v1", "gpt-6-astra", "codex_responses"),
        ("openrouter", "https://openrouter.ai/api/v1", "openai/gpt-6-astra", "chat_completions"),
    ],
)
def test_selected_astra_keeps_provider_transport(provider, endpoint, model, expected):
    effective = _effective_model({"default": "synthetic-prior-model"}, model)
    assert effective == model
    assert _fallback_api_mode(provider, endpoint, effective) == expected
