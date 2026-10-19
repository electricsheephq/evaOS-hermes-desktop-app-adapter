"""``account.usage``: provider quota snapshots (Codex / Claude / OpenRouter) for the Desktop's quota cards.

Reuses ``agent.account_usage``'s fetcher registry — the code ``/usage`` runs, shared-auth aware, with
its token-refresh semantics — but a fetch failure becomes a typed error snapshot instead of failing
open to nothing. Nous is left to ``usage.bars``; a provider with no credential is omitted. The wire
never carries ``raw``, exception text, tokens, URLs or paths: an error is one fixed category plus a
fixed sentence. Providers run in parallel on short-lived daemon threads (never the RPC pool) under
one deadline; results are cached per (profile home, provider).
"""

from __future__ import annotations

import contextvars
import math
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import urlsplit

DEADLINE_S = 20.0
RESULT_TTL_S = 60.0
ERROR_TTL_S = 30.0
_EXCLUDED_PROVIDERS = frozenset({"nous"})  # usage.bars already renders Nous

_ERROR_TEXT = {
    "auth_expired": "The sign-in for this account has expired. Sign in again to see its limits.",
    "rate_limited": "The provider is rate limiting usage checks. Try again in a minute.",
    "timeout": "The provider took too long to report usage. Try again shortly.",
    "unavailable": "Usage for this account is unavailable right now.",
    "not_oauth": "Account limits need an OAuth sign-in, not an API key.",
}

# (profile home, provider) → (monotonic expiry, serialized snapshot or None = omitted).
_cache: dict[tuple[str, str], tuple[float, Optional[dict]]] = {}
_cache_lock = threading.Lock()


def _iso(value: Any) -> Optional[str]:
    return value.isoformat() if isinstance(value, datetime) else None


def _percent(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return min(100.0, max(0.0, float(value)))


def serialize_window(window) -> dict:
    used = _percent(window.used_percent)
    remaining = _percent(getattr(window, "remaining_percent", None))
    if remaining is None and used is not None:
        remaining = 100.0 - used
    return {"label": str(window.label), "used_percent": used, "remaining_percent": remaining,
            "reset_at": _iso(window.reset_at), "detail": str(window.detail) if window.detail else None}


def serialize_snapshot(snapshot) -> dict:
    """A successful ``AccountUsageSnapshot`` → wire dict (``raw`` deliberately dropped)."""
    return {"provider": snapshot.provider, "plan": snapshot.plan, "details": [str(d) for d in snapshot.details if d],
            "windows": [serialize_window(w) for w in snapshot.windows], "error": None,
            "available": bool(snapshot.available), "source": snapshot.source, "fetched_at": _iso(snapshot.fetched_at),
            "title": snapshot.title, "unavailable_reason": None}


def error_snapshot(provider: str, category: str) -> dict:
    text = _ERROR_TEXT[category]
    return {"provider": provider, "plan": None, "details": [text], "windows": [], "error": category,
            "available": False, "source": "account_usage", "fetched_at": datetime.now(timezone.utc).isoformat(),
            "title": "Account limits", "unavailable_reason": text}


def _failure_category(exc: BaseException) -> str:
    import httpx

    from hermes_cli.auth import AuthError
    if isinstance(exc, httpx.TimeoutException):
        return "timeout"
    if isinstance(exc, httpx.HTTPStatusError):
        code = exc.response.status_code
        return "auth_expired" if code in (401, 403) else "rate_limited" if code == 429 else "unavailable"
    return "auth_expired" if isinstance(exc, AuthError) else "unavailable"


_CODEX_POOL_EMPTY = "No available openai-codex credential"  # agent.account_usage tier 3: pool has no selectable entry


def _codex_credentials() -> tuple[Optional[dict], list]:
    """(singleton provider state, persisted pool entries) — located the way ``_read_codex_tokens(_lock=False)``
    does (managed shared-auth source incl.) but lock-free and unvalidated: a poll must neither take the
    auth-store lock nor lose a signed-in-but-broken account to the validator."""
    from hermes_cli.auth import (_auth_file_path, _load_auth_store, _load_provider_state_with_source, _same_path,
                                 read_credential_pool)
    state, source = _load_provider_state_with_source(_load_auth_store(), "openai-codex")
    managed = bool(os.getenv("HERMES_SHARED_AUTH_FILE", "").strip())
    if managed and source is not None and not _same_path(source, _auth_file_path()):
        providers = _load_auth_store(source, fail_closed=True).get("providers")
        state = providers.get("openai-codex") if isinstance(providers, dict) else None
    entries = read_credential_pool("openai-codex")
    return (state if isinstance(state, dict) and isinstance(state.get("tokens"), dict) else None,
            entries if isinstance(entries, list) else [])


def _cooling(entry: dict) -> bool:
    """True while any model cooldown on the entry is still in the future (expired stamps are metadata only)."""
    now = time.time()
    return any(isinstance(until, (int, float)) and until > now
               for until in (entry.get("model_cooldowns") or {}).values())


def _codex_failure(exc: BaseException) -> Optional[dict]:
    """The Codex fetcher raises (rather than returning None) when nothing is signed in, so a failure
    is only an error card when a singleton state or a pool entry (incl. the shared pool) exists."""
    from hermes_cli.auth import AuthError, _validated_codex_token_state
    try:
        state, entries = _codex_credentials()
    except Exception:
        state, entries = None, []
    if state is None and not entries:
        return None
    category = _failure_category(exc)
    if category == "unavailable" and state is not None:  # typed HTTP/timeout evidence wins over inference
        try:
            _validated_codex_token_state(state)
        except AuthError:
            category = "auth_expired"
    if category == "unavailable" and entries and str(exc).startswith(_CODEX_POOL_EMPTY):
        # Unselectable pool: cooling-down (exhausted) entries are a quota wait; dead or empty-token
        # entries need a re-login — the same message covers both, the persisted status tells them apart.
        rows = [e for e in entries if isinstance(e, dict)]
        if any(e.get("last_status") == "exhausted" for e in rows):
            category = "rate_limited"
        elif any(e.get("last_status") != "dead" and str(e.get("access_token") or "").strip() and _cooling(e)
                 for e in rows):
            pass  # a live credential held back only by an active model cooldown (entitlement, not quota or auth)
        else:
            category = "auth_expired"
    return error_snapshot("openai-codex", category)


def _openrouter_credentials() -> Optional[tuple[str, str]]:
    """(base_url, api_key) only when OpenRouter resolves to a key for https://openrouter.ai itself (exact
    host, default port) — never plain http, another port or a look-alike/sub-domain host."""
    from hermes_cli.runtime_provider import resolve_runtime_provider
    try:
        runtime = resolve_runtime_provider(requested="openrouter")
        base_url, api_key = str(runtime.get("base_url") or ""), str(runtime.get("api_key") or "").strip()
        url = urlsplit(base_url)
        origin_ok = url.scheme == "https" and url.hostname == "openrouter.ai" and url.port in (None, 443)
    except Exception:  # incl. ValueError from a malformed port
        return None
    return (base_url, api_key) if api_key and origin_ok else None


def _fetch_one(provider: str) -> Optional[dict]:
    """One provider → wire snapshot, or None to omit it (no resolvable credential)."""
    from agent.account_usage import _USAGE_FETCHERS
    args: tuple = (None, None)  # what fetch_account_usage passes for a sessionless read
    if provider == "openrouter":
        # Resolved once here and handed over, so the key never goes to a non-OpenRouter host and a
        # round-robin pool is not rotated twice.
        if (creds := _openrouter_credentials()) is None:
            return None
        args = creds
    try:
        snapshot = _USAGE_FETCHERS[provider](*args)
    except Exception as exc:
        if provider == "openai-codex":
            return _codex_failure(exc)
        return error_snapshot(provider, _failure_category(exc))
    if snapshot is None:
        return None
    if snapshot.unavailable_reason:
        return error_snapshot(provider, "not_oauth" if "oauth" in snapshot.unavailable_reason.lower() else "unavailable")
    return serialize_snapshot(snapshot) if snapshot.available else error_snapshot(provider, "unavailable")


def _run_into(provider: str, box: dict) -> None:
    try:
        box["value"] = _fetch_one(provider)
    except Exception:
        box["value"] = error_snapshot(provider, "unavailable")


def account_usage_snapshots() -> list[dict]:
    """Snapshots for every registry provider except Nous, in registry order, for the bound profile."""
    from agent.account_usage import _USAGE_FETCHERS
    from hermes_constants import get_hermes_home

    home = str(get_hermes_home())
    providers = [p for p in _USAGE_FETCHERS if p not in _EXCLUDED_PROVIDERS]
    results: dict[str, Optional[dict]] = {}
    with _cache_lock:
        now = time.monotonic()
        for provider in providers:
            hit = _cache.get((home, provider))
            if hit is not None and hit[0] > now:
                results[provider] = hit[1]
    boxes: dict[str, dict] = {p: {} for p in providers if p not in results}
    threads = []
    for provider, box in boxes.items():
        ctx = contextvars.copy_context()  # one per thread: a Context cannot be entered concurrently
        thread = threading.Thread(target=ctx.run, args=(_run_into, provider, box), daemon=True,
                                  name=f"account-usage-{provider}")
        thread.start()
        threads.append(thread)
    deadline = time.monotonic() + DEADLINE_S
    for thread in threads:
        thread.join(max(0.0, deadline - time.monotonic()))
    with _cache_lock:
        now = time.monotonic()
        for provider, box in boxes.items():
            value = box["value"] if "value" in box else error_snapshot(provider, "timeout")
            ttl = ERROR_TTL_S if value is not None and value.get("error") else RESULT_TTL_S
            _cache[(home, provider)] = (now + ttl, value)
            results[provider] = value
    return [snap for p in providers if (snap := results.get(p)) is not None]
