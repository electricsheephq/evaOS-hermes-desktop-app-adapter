"""Fail-closed profile selection for managed one-profile gateways.

evaOS r30 runs one ordinary Hermes gateway process per profile.  The process's
``HERMES_HOME`` is therefore the profile authority; request parameters may
name that profile, but may never retarget the process to a sibling home.

The boundary is enabled by ``HERMES_SHARED_AUTH_FILE`` because that variable
is installed only on the managed r30 topology.  When it is unset, upstream's
multi-profile dashboard and TUI behaviour remain unchanged.
"""

from __future__ import annotations

import os
from typing import Iterable


class ManagedProfileScopeError(PermissionError):
    """A managed request attempted to escape its process profile."""


def managed_profile_name() -> str | None:
    """Return the process-owned profile, or ``None`` outside managed r30.

    Managed r30 never serves the default or a custom Hermes home.  Treating
    either as a usable authority would make an invalid deployment fail open.
    """

    if not os.getenv("HERMES_SHARED_AUTH_FILE", "").strip():
        return None

    from hermes_cli.profiles import get_active_profile_name, profile_matches_home

    name = (get_active_profile_name() or "").strip()
    if name in {"", "default", "custom"} or not profile_matches_home(name):
        raise RuntimeError("managed gateway is not bound to a named profile")
    return name


def require_managed_profile(
    requested: str | None,
    *,
    selectors_for_current: Iterable[str] = (),
) -> str:
    """Resolve ``requested`` without permitting a sibling profile.

    Empty and ``current`` selectors mean the process-owned profile.  Callers
    whose legacy API uses a bounded aggregate selector (for example ``all``)
    may explicitly map it to the one profile this process is allowed to see.
    """

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
