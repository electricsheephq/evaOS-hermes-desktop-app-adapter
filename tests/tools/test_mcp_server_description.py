"""An ``mcp_servers`` entry's optional display-only ``description`` reaches the model.

It prefixes every tool description of that server and heads the server's group in the deferred
catalog listing, once. It never joins route identity or the schema-cache fingerprint, and a
missing or non-string value changes nothing.
"""

import pytest

import tools.mcp_tool as mcp
from tools import mcp_tool_registration as _mcp_registration
from tools.mcp_schema_cache import config_fingerprint
from tools.registry import registry
from tools.tool_search_catalog import build_catalog_listing_with_form

SERVER = "evaos-pipedream-gmail"
TOOL = "mcp__evaos_pipedream_gmail__"
LABEL = "Gmail · Work · work@example.test"


def _config(**extra):
    return {"auth": "evaos_lease", "app_slug": "gmail", "lazy": True,
            "external_user_id": "acct_TEST", "account_id": "apn_TEST", **extra}


def _entry():
    return {"fingerprint": config_fingerprint(_config()), "utility_tools": [], "tools": [
        {"name": "send", "description": "Send an email. Supports attachments.",
         "inputSchema": {"type": "object", "properties": {}}},
        {"name": "search", "description": "Search messages.",
         "inputSchema": {"type": "object", "properties": {}}}]}


@pytest.fixture(autouse=True)
def _reset_mcp_state():
    saved = [(state, dict(state)) for state in (
        mcp._lazy_server_configs, mcp._lazy_server_fingerprints, mcp._lazy_server_tool_names)]
    yield
    for name in [n for names in mcp._lazy_server_tool_names.values() for n in names]:
        registry.deregister(name)
    for state, old in saved:
        state.clear()
        state.update(old)


def _register_and_list(config):
    names = _mcp_registration._register_from_cache_sync(SERVER, config, _entry())
    defs = [{"type": "function", "function": registry.get_entry(name).schema} for name in names]
    return {d["function"]["name"]: d["function"]["description"] for d in defs}, \
        build_catalog_listing_with_form(defs, max_tokens=4000)[0]


def test_description_prefixes_tools_and_heads_the_listing_without_joining_identity():
    labelled = _config(description=f" {LABEL}\n")
    assert config_fingerprint(labelled) == config_fingerprint(_config())
    assert _mcp_registration._connection_identity(labelled) == \
        _mcp_registration._connection_identity(_config())

    descriptions, listing = _register_and_list(labelled)
    assert descriptions == {
        f"{TOOL}send": f"{LABEL} — Send an email. Supports attachments.",
        f"{TOOL}search": f"{LABEL} — Search messages.",
    }
    assert f"{SERVER} [{LABEL}] tools (2):" in listing
    assert f"- {TOOL}send: Send an email." in listing
    assert listing.count("work@example.test") == 1


@pytest.mark.parametrize("config", [_config(), _config(description=7), _config(description=" ")])
def test_absent_or_unusable_description_changes_nothing(config):
    descriptions, listing = _register_and_list(config)
    assert descriptions == {
        f"{TOOL}send": "Send an email. Supports attachments.",
        f"{TOOL}search": "Search messages.",
    }
    assert f"{SERVER} tools (2):" in listing


def _listing_for(scope, monkeypatch, *, max_tokens=4000):
    monkeypatch.setattr(registry, "current_scope_key", lambda: scope)
    names = registry.get_tool_names_for_toolset(f"mcp-{SERVER}")
    defs = [{"type": "function", "function": registry.get_entry(name).schema} for name in names]
    return build_catalog_listing_with_form(defs, max_tokens=max_tokens)


def test_another_profiles_description_never_changes_this_profiles_listing(monkeypatch):
    """B has no description and a native tool whose own text looks prefixed."""
    import tools.mcp_tool as core

    native = {"fingerprint": "b", "utility_tools": [], "tools": [
        {"name": "search", "description": "Gmail — Search messages.",
         "inputSchema": {"type": "object", "properties": {}}}]}
    labelled = {**native, "tools": [{**native["tools"][0], "description": "Search messages."}]}
    registered = []
    try:
        monkeypatch.setattr(core, "_mcp_registry_scope", lambda: "B")
        registered += _mcp_registration._register_from_cache_sync(SERVER, _config(), native)
        before = _listing_for("B", monkeypatch)
        monkeypatch.setattr(core, "_mcp_registry_scope", lambda: "A")
        registered += _mcp_registration._register_from_cache_sync(
            SERVER, _config(description="Gmail"), labelled)
        assert f"{SERVER} [Gmail] tools (1):" in _listing_for("A", monkeypatch)[0]
        after = _listing_for("B", monkeypatch)
    finally:
        for scope in ("A", "B"):
            for name in set(registered):
                registry.deregister(name, scope=scope)
    assert before == after
    assert f"{SERVER} tools (1):\n- {TOOL}search: Gmail — Search messages." in after[0]


def test_em_dash_label_survives_every_listing_form():
    label = "Gmail · Work — Sales · work@example.test"
    names = _mcp_registration._register_from_cache_sync(SERVER, _config(description=label), _entry())
    defs = [{"type": "function", "function": registry.get_entry(name).schema} for name in names]
    forms = {}
    for max_tokens in range(4000, 0, -1):
        text, form = build_catalog_listing_with_form(defs, max_tokens=max_tokens)
        if text is None:
            break
        forms.setdefault(form, text)
    assert {"full", "names", "groups"} <= set(forms)
    for text in forms.values():
        assert f"{SERVER} [{label}] " in text
        assert text.count("work@example.test") == 1
    assert f"- {TOOL}send: Send an email." in forms["full"]
