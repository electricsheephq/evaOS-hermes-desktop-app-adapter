"""The real installer keeps the checkout's uv policy even after locked-sync failure."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(os.name == "nt", reason="Unix installer behavior")
def test_fallback_install_keeps_project_cutoff_and_exempts_without_ambient_config(tmp_path):
    bash = shutil.which("bash")
    if bash is None:
        pytest.skip("bash unavailable")

    project = tmp_path / "project"
    project.mkdir()
    (project / "pyproject.toml").write_text(
        '[project.optional-dependencies]\nall = ["hermes-agent[cron]"]\n'
        '[tool.uv]\nexclude-newer = "14 days"\n'
        '[tool.uv.exclude-newer-package]\nsynthetic-exempt = false\n',
        encoding="utf-8",
    )
    (project / "uv.lock").write_text("# synthetic lock forces Tier 0\n", encoding="utf-8")
    record = tmp_path / "calls.jsonl"
    fake_uv = tmp_path / "fake_uv.py"
    fake_uv.write_text(
        """import json, os, sys, tomllib
from pathlib import Path
policy = tomllib.loads(Path("pyproject.toml").read_text())["tool"]["uv"]
isolated = os.environ.get("XDG_CONFIG_HOME", "")
visible = (
    "UV_NO_CONFIG" not in os.environ and "UV_CONFIG_FILE" not in os.environ
    and isolated == os.environ.get("XDG_CONFIG_DIRS")
    and Path(isolated).is_dir()
)
with open(os.environ["UV_TEST_RECORD"], "a") as out:
    out.write(json.dumps({"args": sys.argv[1:], "policy": policy, "isolated": visible}) + "\\n")
# Force the supported fallback, then accept the first pip tier.
sys.exit(1 if sys.argv[1] == "sync" else 0)
""",
        encoding="utf-8",
    )
    # Source through the installer's existing read-only manifest mode, not a
    # copied/extracted function or an install against the operator's checkout.
    harness = """
source "$INSTALLER_UNDER_TEST" --manifest >/dev/null
INSTALL_DIR="$UV_TEST_PROJECT"
PYTHON_PATH="$UV_TEST_PYTHON"
UV_CMD="$UV_TEST_PYTHON $UV_TEST_FAKE"
USE_VENV=false
DISTRO=synthetic-test
cd "$INSTALL_DIR"
install_deps
test "$UV_NO_CONFIG" = 1
test "$UV_CONFIG_FILE" = /synthetic/ambient.toml
"""
    env = {
        **os.environ,
        "INSTALLER_UNDER_TEST": str(REPO_ROOT / "scripts/install.sh"),
        "UV_TEST_PROJECT": str(project),
        "UV_TEST_PYTHON": sys.executable,
        "UV_TEST_FAKE": str(fake_uv),
        "UV_TEST_RECORD": str(record),
        "UV_CONFIG_FILE": "/synthetic/ambient.toml",
    }
    result = subprocess.run([bash, "-c", harness], env=env, capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    calls = [json.loads(line) for line in record.read_text().splitlines()]
    assert [call["args"] for call in calls] == [
        ["sync", "--extra", "all", "--locked"],
        ["pip", "install", "-e", ".[all]"],
    ]
    assert all(call["isolated"] for call in calls), "fallback hid the project's resolver policy"
    assert all(call["policy"] == {
        "exclude-newer": "14 days", "exclude-newer-package": {"synthetic-exempt": False}
    } for call in calls)
