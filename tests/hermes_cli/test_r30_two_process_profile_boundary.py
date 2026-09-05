"""Two independent profile processes share auth without sharing profile state."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys


_CHILD = r"""
import json
import os
from pathlib import Path

from hermes_cli.auth import read_credential_pool_with_source
from hermes_cli.config import load_config
from hermes_cli.managed_profile_scope import (
    ManagedProfileScopeError,
    managed_profile_name,
    require_managed_profile,
)
from hermes_constants import get_hermes_home

owner = managed_profile_name()
try:
    require_managed_profile(os.environ["R30_SIBLING_PROFILE"])
except ManagedProfileScopeError:
    sibling_denied = True
else:
    sibling_denied = False

entries, source = read_credential_pool_with_source("openrouter")
home = get_hermes_home()
print(json.dumps({
    "owner": owner,
    "home_name": home.name,
    "personality": (load_config().get("display") or {}).get("personality"),
    "skill_marker": (home / "skills" / "fixture" / "marker.txt").read_text().strip(),
    "credential_ids": sorted(entry["id"] for entry in entries),
    "shared_source": Path(source).resolve() == Path(os.environ["HERMES_SHARED_AUTH_FILE"]).resolve(),
    "sibling_denied": sibling_denied,
}, sort_keys=True))
"""


def _write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")


def test_two_profile_processes_share_only_the_managed_auth_file(tmp_path):
    root = tmp_path / ".hermes"
    shared = root / "shared-auth" / "auth.json"
    shared.parent.mkdir(parents=True)
    _write_json(
        shared,
        {
            "version": 1,
            "credential_pool": {
                "openrouter": [
                    {
                        "id": "company-synthetic",
                        "label": "company",
                        "auth_type": "api_key",
                        "priority": 0,
                        "source": "test",
                        "access_token": "synthetic-not-a-secret",
                    }
                ]
            },
        },
    )
    if os.name != "nt":
        shared.chmod(0o660)
        os.chown(shared, -1, os.getgid())

    processes = {}
    for name, sibling, personality in (
        ("alpha", "beta", "default"),
        ("beta", "alpha", "neutral"),
    ):
        home = root / "profiles" / name
        skill_dir = home / "skills" / "fixture"
        skill_dir.mkdir(parents=True)
        (home / "config.yaml").write_text(
            f"display:\n  personality: {personality}\n", encoding="utf-8"
        )
        (skill_dir / "marker.txt").write_text(name, encoding="utf-8")
        _write_json(home / "auth.json", {"version": 1, "credential_pool": {}})
        env = os.environ.copy()
        env.update(
            {
                "HOME": str(tmp_path),
                "HERMES_HOME": str(home),
                "HERMES_SHARED_AUTH_FILE": str(shared),
                "R30_SIBLING_PROFILE": sibling,
            }
        )
        processes[name] = subprocess.Popen(
            [sys.executable, "-c", _CHILD],
            cwd=Path(__file__).resolve().parents[2],
            env=env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

    results = {}
    for name, process in processes.items():
        stdout, stderr = process.communicate(timeout=20)
        assert process.returncode == 0, stderr
        results[name] = json.loads(stdout)

    for name, personality in (("alpha", "default"), ("beta", "neutral")):
        assert results[name] == {
            "credential_ids": ["company-synthetic"],
            "home_name": name,
            "owner": name,
            "personality": personality,
            "shared_source": True,
            "sibling_denied": True,
            "skill_marker": name,
        }
