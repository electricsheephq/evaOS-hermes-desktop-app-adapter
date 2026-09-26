"""r34 R1 as a permanent test: a managed profile's config is never migrated or stamped on disk.

The predecessor (r33.6) writes and settles a profile config at ITS schema version under
``HERMES_MANAGED_DIR``; the tree under test then runs ``migrate_config`` on the same home in a separate
interpreter. Managed: config.yaml, .env and the managed scope are byte-identical afterwards and the
stamp stays at the predecessor's version (the in-memory read still overlays current defaults).
The unmanaged parametrization is the positive control: the same probe on the same bytes does migrate,
stamp the current version and normalize .env, so an unchanged file is not an inert probe.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from tests.r34_compat import _pair as pair

# A settled operator/provisioning .env: CRLF and indented assignments are valid input which the
# unmanaged migration normalizes (sanitize_env_file); a managed update must leave them alone.
ENV_BYTES = b"SYNTHETIC_R34_SETTING=kept\r\n  SYNTHETIC_R34_INDENTED=kept\n"
MANAGED_SCOPE_BYTES = b"model_catalog:\n  ttl_hours: 1\n"

_SCRIPT = r'''
import json, os
from pathlib import Path

HOME = Path(os.environ["HERMES_HOME"])
PHASE = os.environ["R34_PHASE"]
MANAGED_DIR = os.environ.get("R34_MANAGED_DIR")
if MANAGED_DIR:
    os.environ["HERMES_MANAGED_DIR"] = MANAGED_DIR


def main():
    from hermes_cli.config import DEFAULT_CONFIG, load_config, migrate_config, read_raw_config
    path = HOME / "config.yaml"
    if PHASE == "seed":
        HOME.mkdir(parents=True, exist_ok=True)
        own = DEFAULT_CONFIG["_config_version"]
        path.write_text(
            f"_config_version: {own}\nmodel:\n  default: synthetic-r34-model\n"
            "model_catalog:\n  ttl_hours: 7\n",
            encoding="utf-8",
        )
        (HOME / ".env").write_bytes(bytes.fromhex(os.environ["R34_ENV_HEX"]))
    migrate_config(interactive=False, quiet=True)
    raw = read_raw_config()
    return {
        "status": "ok",
        "phase": PHASE,
        "own_version": DEFAULT_CONFIG["_config_version"],
        "version": raw.get("_config_version"),
        "model": (raw.get("model") or {}).get("default"),
        "loaded_version": load_config().get("_config_version"),
    }


try:
    print(json.dumps(main(), sort_keys=True))
except Exception as exc:
    print(json.dumps({"status": "error", "phase": PHASE, "error_type": type(exc).__name__}, sort_keys=True))
    raise SystemExit(3)
'''


@pytest.mark.parametrize("managed", [True, False], ids=["managed", "unmanaged-positive-control"])
def test_predecessor_config_is_not_migrated_or_stamped_under_managed_dir(
    tmp_path: Path, request: pytest.FixtureRequest, managed: bool
) -> None:
    predecessor = pair.predecessor_root(request.config)
    target = pair.target_root(request.config)
    home = tmp_path / "profile-home"
    managed_dir = tmp_path / "managed-scope"
    managed_dir.mkdir()
    (managed_dir / "config.yaml").write_bytes(MANAGED_SCOPE_BYTES)
    scope = {"R34_MANAGED_DIR": str(managed_dir)} if managed else {}

    seeded = pair.run_child(predecessor, _SCRIPT, home=home, R34_PHASE="seed",
                            R34_ENV_HEX=ENV_BYTES.hex(), **scope)
    predecessor_version = seeded["own_version"]
    assert seeded["version"] == predecessor_version
    if managed:
        # The predecessor carries the same guard: its own settle pass left .env alone.
        assert (home / ".env").read_bytes() == ENV_BYTES
    # Unmanaged, the predecessor normalized .env while settling; restore the raw bytes so both
    # parametrizations hand the tree under test the same input.
    (home / ".env").write_bytes(ENV_BYTES)
    config_before = (home / "config.yaml").read_bytes()
    env_before = (home / ".env").read_bytes()

    migrated = pair.run_child(target, _SCRIPT, home=home, R34_PHASE="migrate", **scope)
    assert migrated["own_version"] > predecessor_version, "the pair must span a config schema bump"
    assert migrated["model"] == "synthetic-r34-model"
    assert (managed_dir / "config.yaml").read_bytes() == MANAGED_SCOPE_BYTES
    if managed:
        assert migrated["version"] == predecessor_version
        assert (home / "config.yaml").read_bytes() == config_before
        assert (home / ".env").read_bytes() == env_before
        assert not list(home.glob(".env_*.tmp"))
    else:
        assert migrated["version"] == migrated["own_version"]
        assert (home / "config.yaml").read_bytes() != config_before
        assert (home / ".env").read_bytes() != env_before
