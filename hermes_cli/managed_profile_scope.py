"""Fail-closed profile selection for managed one-profile gateways.

Managed desktop services run one ordinary Hermes gateway process per profile.
The process's ``HERMES_HOME`` is therefore the profile authority; request
parameters may name that profile, but may never retarget the process to a
sibling home. When the managed binding is absent, upstream multi-profile
dashboard and TUI behaviour remain unchanged.
"""

from __future__ import annotations

import os
from typing import Iterable


class ManagedProfileScopeError(PermissionError):
    """A managed request attempted to escape its process profile."""


def managed_profile_name() -> str | None:
    """Return the process-owned profile, or ``None`` outside managed mode."""
    if not os.getenv("HERMES_SHARED_AUTH_FILE", "").strip():
        return None

    from hermes_cli.profiles import (
        _flat_managed_profile,
        get_active_profile_name,
        profile_matches_home,
    )

    name = (get_active_profile_name() or "").strip()
    flat = _flat_managed_profile()
    if (
        name in {"", "custom"}
        or (name == "default" and (flat is None or flat[0] != "default"))
        or not profile_matches_home(name)
    ):
        raise RuntimeError("managed gateway is not bound to a named profile")
    return name


def require_managed_profile(
    requested: str | None,
    *,
    selectors_for_current: Iterable[str] = (),
) -> str:
    """Resolve ``requested`` without permitting a sibling profile."""
    raw = (requested or "").strip()
    owner = managed_profile_name()
    if owner is None:
        return raw

    lowered = raw.lower()
    if not raw or lowered == "current" or lowered in {
        value.strip().lower() for value in selectors_for_current
    }:
        return owner

    from hermes_cli.profiles import normalize_profile_name, validate_profile_name

    try:
        name = normalize_profile_name(raw)
        validate_profile_name(name)
    except ValueError as exc:
        raise ManagedProfileScopeError("profile is not authorized") from exc
    if name != owner:
        raise ManagedProfileScopeError("profile is not authorized")
    return owner
