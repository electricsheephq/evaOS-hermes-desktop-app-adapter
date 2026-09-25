"""Managed scope — IT-pushed, user-immutable config & env layer.

DISTINCT from ``hermes_cli.config.is_managed()`` / ``HERMES_MANAGED`` (a coarse package-manager
write-lock that blocks all mutation); this layer injects specific immutable values. The two are
independent and may coexist. v1 enforcement is filesystem permissions only (see
``docs/design/managed-scope.md`` §7); ``get_managed_dir()`` is the single seam for adding
macOS / Windows native locations later.
"""
from __future__ import annotations

import copy
import logging
import os
import re
import threading
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Optional


# Stale-module bridge: this module binds ``utils.file_signature`` at import time, so a fresh
# import in a post-pull updater process (pre-handoff purge keeps root modules cached) dies
# unless the stale ``utils`` is dropped first. See hermes_cli.stale_modules.
from hermes_cli.stale_modules import drop_stale_root_modules

drop_stale_root_modules()

from utils import fast_safe_load, file_signature

logger = logging.getLogger(__name__)

# POSIX default. Other-platform locations belong ONLY inside get_managed_dir().
_DEFAULT_MANAGED_DIR = Path("/etc/hermes")

_CACHE_LOCK = threading.Lock()
# path_key -> (*file_signature, parsed)
_CONFIG_CACHE: Dict[str, tuple] = {}
_ENV_CACHE: Dict[str, tuple] = {}


def _under_pytest() -> bool:
    """True inside the test suite: ignore the system ``/etc/hermes`` so a real managed scope on a
    dev/CI box can't leak policy into the suite. An explicit ``HERMES_MANAGED_DIR`` still wins."""
    return "PYTEST_CURRENT_TEST" in os.environ


def get_managed_dir() -> Optional[Path]:
    """Resolve the managed-scope directory, or None when no scope is present.

    Priority: ``$HERMES_MANAGED_DIR`` (IT-only bootstrap override; never persisted to any .env;
    honored only when non-empty AND the directory exists), then the selected profile under
    ``EVAOS_HERMES_MANAGED_PROFILE_ROOT``, then ``/etc/hermes`` when it exists.
    A missing directory resolves to None — the common case, so it must be cheap + side-effect-free.
    """
    override = os.environ.get("HERMES_MANAGED_DIR", "").strip()
    if override:
        p = Path(override)
    elif profile_root := os.environ.get("EVAOS_HERMES_MANAGED_PROFILE_ROOT", "").strip():
        from hermes_constants import get_hermes_home

        p = Path(profile_root) / get_hermes_home().name
    elif _under_pytest():
        return None
    else:
        p = _DEFAULT_MANAGED_DIR
    return p if p.is_dir() else None


def invalidate_managed_cache() -> None:
    """Drop cached managed config/env. For tests and post-edit reloads."""
    with _CACHE_LOCK:
        _CONFIG_CACHE.clear()
        _ENV_CACHE.clear()


def _cached_read(path: Path, cache: Dict[str, tuple], parse):
    """Shared stat-signature-keyed read; returns a deepcopy of the parsed value.

    ``None`` when the file is absent or fails to parse (fail-open). A parse failure is logged
    LOUDLY — the admin needs to know their policy isn't applied — but never raises, so a malformed
    managed file can't brick startup.
    """
    try:
        st = path.stat()
    except OSError:
        return None  # absent
    key = file_signature(st)
    path_key = str(path)
    with _CACHE_LOCK:
        hit = cache.get(path_key)
        if hit is not None and hit[:len(key)] == key:
            return copy.deepcopy(hit[len(key)])
    try:
        parsed = parse(path)
    except Exception as exc:  # noqa: BLE001 — fail-open, but LOUD
        logger.warning(
            "managed scope: failed to parse %s: %s — IGNORING this managed file. "
            "Admin policy from this file is NOT being applied. Fix and restart.",
            path, exc)
        return None
    with _CACHE_LOCK:
        cache[path_key] = (*key, copy.deepcopy(parsed))
    return parsed


def _load_managed_file(name: str, cache: Dict[str, tuple], parse) -> dict:
    managed_dir = get_managed_dir()
    if managed_dir is None:
        return {}
    parsed = _cached_read(managed_dir / name, cache, parse)
    return parsed if isinstance(parsed, dict) else {}


def load_managed_config() -> dict:
    """Parsed managed config.yaml, or {} when absent/malformed (fail-open)."""

    return _load_managed_file("config.yaml", _CONFIG_CACHE, lambda p: fast_safe_load(p.read_text(encoding="utf-8")) or {})


def managed_config_env_keys() -> set[str]:
    """Return environment names referenced by the root-managed config.

    Profile dotenv loading uses this before it mutates ``os.environ`` so a
    writable profile cannot redefine a placeholder that supplies managed MCP
    identity or another administrator-owned config leaf.
    """
    keys: set[str] = set()

    def visit(value) -> None:
        if isinstance(value, str):
            for match in re.finditer(r"\${([^}]+)}", value):
                ref = match.group(1).strip()
                if ref.startswith("env:"):
                    ref = ref[len("env:"):].strip()
                elif ":" in ref and re.match(r"^[a-z][a-z0-9_-]*:", ref):
                    continue
                if ref:
                    keys.add(ref)
        elif isinstance(value, dict):
            for child in value.values():
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(load_managed_config())
    return keys


def load_managed_env() -> Dict[str, str]:
    """Parsed managed .env (KEY=VALUE), or {} when absent (fail-open)."""
    return _load_managed_file(".env", _ENV_CACHE, _parse_managed_env)


def _parse_managed_env(path: Path) -> Dict[str, str]:
    from agent.secret_scope import load_env_file

    path.read_text(encoding="utf-8-sig")  # load_env_file swallows decode errors; an admin file must fail LOUD
    return load_env_file(path)


def expand_managed_config(config: Optional[dict] = None) -> dict:
    """Expand trusted administrator refs without changing the shared process env."""
    from hermes_cli.config import _expand_env_vars

    managed = load_managed_config() if config is None else config
    env = dict(os.environ)
    env.update(load_managed_env())
    return _expand_env_vars(managed, env=env)


_PLUGIN_LIST_KEYS = ("enabled", "disabled")


def _name_list(value: Any) -> list[str]:
    return [str(item) for item in value] if isinstance(value, list) else []


def _ordered_union(*values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(item for value in values for item in value))


def compose_plugin_selection(profile_config: dict, managed_config: dict) -> Optional[dict[str, list[str]]]:
    """Compose the two managed plugin lists without making other managed lists additive."""
    managed_plugins = managed_config.get("plugins") if isinstance(managed_config, dict) else None
    if not isinstance(managed_plugins, dict) or not any(key in managed_plugins for key in _PLUGIN_LIST_KEYS):
        return None
    profile_plugins = profile_config.get("plugins") if isinstance(profile_config, dict) else None
    profile_plugins = profile_plugins if isinstance(profile_plugins, dict) else {}
    managed_enabled = _name_list(managed_plugins.get("enabled"))
    managed_disabled = _name_list(managed_plugins.get("disabled"))
    managed_enabled_set = set(managed_enabled)
    profile_disabled = _name_list(profile_plugins.get("disabled"))
    ignored_profile_denies = [name for name in profile_disabled if name in managed_enabled_set]
    if ignored_profile_denies:
        logger.warning(
            "Ignoring profile plugin disable for managed-enabled identity %s",
            ", ".join(ignored_profile_denies),
        )
    effective_profile_disabled = [
        name for name in profile_disabled if name not in managed_enabled_set
    ]
    denied = set(managed_disabled) | set(effective_profile_disabled)
    return {
        "enabled": [
            name for name in _ordered_union(managed_enabled, _name_list(profile_plugins.get("enabled")))
            if name not in denied
        ],
        "disabled": _ordered_union(managed_disabled, effective_profile_disabled),
    }


def plugin_selection_for_save(
    config: dict, managed_config: dict, persisted_config: dict, *, preserve_missing: bool
) -> dict:
    """Recover profile-owned plugin lists from an effective managed configuration."""
    managed_plugins = managed_config.get("plugins") if isinstance(managed_config, dict) else None
    if not isinstance(managed_plugins, dict) or not any(key in managed_plugins for key in _PLUGIN_LIST_KEYS):
        return config
    candidate_plugins = config.get("plugins") if isinstance(config.get("plugins"), dict) else {}
    persisted_plugins = (
        persisted_config.get("plugins") if isinstance(persisted_config.get("plugins"), dict) else {}
    )
    managed_enabled = set(_name_list(managed_plugins.get("enabled")))
    managed_disabled = set(_name_list(managed_plugins.get("disabled")))
    candidate_enabled = _name_list(candidate_plugins.get("enabled"))
    enabled_present = "enabled" in candidate_plugins
    if not enabled_present and preserve_missing:
        candidate_enabled = _name_list(persisted_plugins.get("enabled"))
    candidate_disabled = _name_list(candidate_plugins.get("disabled"))
    disabled_present = "disabled" in candidate_plugins
    if not disabled_present and preserve_missing:
        candidate_disabled = _name_list(persisted_plugins.get("disabled"))
    persisted_enabled = (
        _name_list(persisted_plugins.get("enabled"))
        if enabled_present or preserve_missing else []
    )
    persisted_disabled = (
        _name_list(persisted_plugins.get("disabled"))
        if disabled_present or preserve_missing else []
    )
    enabled_set, disabled_set = set(candidate_enabled), set(candidate_disabled)
    profile_enabled = [
        name for name in persisted_enabled if name in enabled_set or name in managed_disabled
    ]
    profile_enabled = _ordered_union(
        profile_enabled,
        (name for name in candidate_enabled if name not in managed_enabled),
    )
    profile_disabled = [
        name for name in persisted_disabled
        if name in disabled_set or name in managed_enabled
    ]
    profile_disabled = _ordered_union(
        profile_disabled,
        (name for name in candidate_disabled if name not in managed_disabled),
    )
    result = copy.deepcopy(config)
    if not isinstance(result.get("plugins"), dict):
        result["plugins"] = {}
    result["plugins"].update(
        {"enabled": profile_enabled, "disabled": profile_disabled}
    )
    return result


def _operator_owned(manifest: Any) -> bool:
    """Return whether a plugin candidate is owned outside the profile/project boundary."""
    source = getattr(manifest, "source", "")
    if source == "entrypoint" or source not in {"user", "project"}:
        return True
    if os.name != "posix":
        return False
    path = getattr(manifest, "path", None)
    if not path:
        return False
    try:
        return os.lstat(path).st_uid == 0
    except OSError:
        return False


def filter_managed_plugin_candidates(manifests: Iterable[Any], key_fn: Callable[[Any], str]) -> list[Any]:
    """Keep operator-owned candidates ahead of profile/project shadows of managed identities."""
    managed = expand_managed_config(load_managed_config())
    plugins = managed.get("plugins") if isinstance(managed, dict) else None
    reserved = (
        set(_name_list(plugins.get("enabled"))) | set(_name_list(plugins.get("disabled")))
        if isinstance(plugins, dict) else set()
    )
    if not reserved:
        return list(manifests)
    candidates = list(manifests)

    def _claims(manifest: Any) -> set[str]:
        values = {str(key_fn(manifest)), str(getattr(manifest, "name", ""))}
        return values

    classified = [
        (manifest, _claims(manifest), _operator_owned(manifest))
        for manifest in candidates
    ]
    operator_claims = {
        identity
        for _manifest, claims, owned in classified
        if owned and claims & reserved
        for identity in claims
    }
    eligible = []
    for manifest, claims, owned in classified:
        directory = Path(str(getattr(manifest, "path", "") or "")).name
        matched = claims & operator_claims
        if not owned and matched:
            logger.warning(
                "Skipping plugin directory %s: it claims managed plugin identity %s",
                directory or "<non-directory>", ", ".join(sorted(matched)),
            )
            continue
        eligible.append(manifest)
    return eligible


def apply_managed_overlay(config: dict) -> dict:
    """Overlay administrator-pinned config values on top of an already-built dict.

    ``${VAR}`` refs expand against the profile's managed env, then the process env, never the
    writable profile env. A bare root ``model: x/y`` string is promoted
    to ``model.default`` so it can't clobber the dict shape callers expect; managed values
    deep-merge ON TOP per leaf while sibling keys stay user-controlled. Fail-open: returns
    ``config`` unchanged when no scope is present or on any error. Mutates and returns ``config``.
    """
    try:
        managed = load_managed_config()
        if not managed:
            return config
        # Imported lazily to avoid an import cycle (config imports managed_scope).
        from hermes_cli.config import _deep_merge, _normalize_root_model_keys
        managed_expanded = _normalize_root_model_keys(expand_managed_config(managed))
        # _normalize_root_model_keys only promotes the string when root provider/base_url
        # keys exist to migrate; handle the bare case here (matches cli.py) so _deep_merge
        # never replaces the caller's ``model`` dict with a string.
        if isinstance(managed_expanded.get("model"), str):
            managed_expanded = dict(managed_expanded)
            managed_expanded["model"] = {"default": managed_expanded["model"]}
        merged = _deep_merge(config, managed_expanded)
        selection = compose_plugin_selection(config, managed_expanded)
        if selection is not None:
            merged.setdefault("plugins", {}).update(selection)
        return merged
    except Exception:  # noqa: BLE001 — overlay must never break a caller
        logger.warning("managed scope: failed to apply config overlay", exc_info=True)
        return config


def _flatten_keys(d: dict, prefix: str = "") -> set:
    keys: set = set()
    for k, v in d.items():
        dotted = f"{prefix}.{k}" if prefix else str(k)
        if isinstance(v, dict) and v:
            keys |= _flatten_keys(v, dotted)
        else:
            keys.add(dotted)
    return keys


def managed_config_keys() -> set:
    """Dotted leaf keys pinned by the managed config (e.g. {'model.default'})."""
    return _flatten_keys(load_managed_config())


def is_key_managed(dotted_key: str) -> bool:
    """True if the exact dotted config key is pinned by the managed layer."""
    return dotted_key in managed_config_keys()


def is_env_managed(name: str) -> bool:
    """True if the env name is owned by managed env or config placeholders."""
    return name in load_managed_env() or name in managed_config_env_keys()
