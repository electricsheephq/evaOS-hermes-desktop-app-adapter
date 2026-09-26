"""The r34 immutable synthetic-compatibility pair, prepared by ``.github/workflows/tests.yml``.

Predecessor: the fleet's last serving runtime, r33.6. Plugin: LCM-X v0.24.1, the managed payload's
source commit. Both are detached exact-SHA siblings of this checkout; path options serve other hosts.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any

import pytest

PREDECESSOR_TAG = "evaos-runtime-es.12-v0.21.2-r33.6"
PREDECESSOR_COMMIT = "2d10969e7d6fab477c4aa4f7e4c9e4df1f524e9a"
LCMX_REPO_URL = "https://github.com/electricsheephq/lcm-x"
LCMX_TAG = "v0.24.1"
LCMX_COMMIT = "98ac62fee5316cdf461e77f28951720f523489f1"
LCMX_TREE = "514b3562a50618f5ff18f876f617ba04221e045d"
LCMX_VERSION = "0.24.1"
LCMX_PLUGIN = "hermes-lcm-x"
LCMX_ENGINE = "lcm-x"
RETIRED_PLUGIN = "hermes-lcm"

CURRENT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_PREDECESSOR = CURRENT_ROOT.parent / "evaos-r34-r336-baseline"
DEFAULT_LCMX_SOURCE = CURRENT_ROOT.parent / "evaos-r34-lcmx-source"


def _option_path(config: pytest.Config, option: str, default: Path) -> Path:
    selected = config.getoption(option)
    return Path(selected).expanduser() if selected else default


def git_head(root: Path) -> str:
    return subprocess.run(
        ["git", "-C", str(root), "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip()


def predecessor_root(config: pytest.Config) -> Path:
    root = _option_path(config, "--r34-predecessor", DEFAULT_PREDECESSOR)
    if not root.is_dir():
        pytest.fail(f"required immutable predecessor is missing: {root}; provide --r34-predecessor")
    assert git_head(root) == PREDECESSOR_COMMIT, "predecessor runtime identity drift"
    return root


def target_root(config: pytest.Config) -> Path:
    return _option_path(config, "--r34-target-runtime", CURRENT_ROOT)


def lcmx_source(config: pytest.Config) -> tuple[Path, str]:
    source = _option_path(config, "--r34-lcmx-source", DEFAULT_LCMX_SOURCE)
    if not source.is_dir():
        pytest.fail(f"pinned LCM-X checkout is missing: {source}; provide --r34-lcmx-source, "
                    f"or clone {LCMX_REPO_URL} and detach at {LCMX_COMMIT}")
    ref = config.getoption("--r34-lcmx-ref") or LCMX_COMMIT
    probe = subprocess.run(["git", "-C", str(source), "cat-file", "-e", f"{ref}^{{commit}}"],
                           check=False, capture_output=True)
    if probe.returncode != 0:
        pytest.fail(f"commit {ref} is unavailable in {source}")
    return source, ref


def run_child(root: Path, script: str, *, home: Path, **variables: str) -> dict[str, Any]:
    """Run ``script`` against the runtime tree at ``root`` in a fresh interpreter; return its JSON receipt."""
    env = os.environ.copy()
    env["HERMES_HOME"] = str(home)
    env["HOME"] = str(home / "operator-home")
    env["XDG_CONFIG_HOME"] = str(home / "xdg-config")
    env["PYTHONPATH"] = str(root)
    env["PYTHONNOUSERSITE"] = "1"
    for key in tuple(env):
        if key.startswith("HERMES_") and key != "HERMES_HOME":
            env.pop(key, None)
    env.update(variables)
    completed = subprocess.run([sys.executable, "-B", "-c", script], cwd=root, env=env,
                               capture_output=True, text=True, check=False)
    payload = None
    for line in reversed(completed.stdout.splitlines()):
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict):
            payload = candidate
            break
    if completed.returncode != 0 or payload is None or payload.get("status") != "ok":
        detail = payload or {"status": "no-payload"}
        pytest.fail(
            f"compat subprocess failed root={root} variables={sorted(variables)} "
            f"returncode={completed.returncode} stage={detail.get('stage', detail.get('phase'))} "
            f"error_type={detail.get('error_type', 'unknown')}\nstderr tail:\n{completed.stderr[-2000:]}"
        )
    return payload
