"""Guards for the r29 base cut owned by adapter issue #147."""

from __future__ import annotations

import importlib.metadata
import tomllib
from pathlib import Path

import hermes_cli


REPO_ROOT = Path(__file__).resolve().parents[1]


def _pyproject() -> dict:
    return tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))


def _lock() -> dict:
    return tomllib.loads((REPO_ROOT / "uv.lock").read_text(encoding="utf-8"))


def test_package_and_runtime_versions_match() -> None:
    project_version = _pyproject()["project"]["version"]
    assert project_version == hermes_cli.__version__


def test_r29_cryptography_override_and_lock_stay_on_50() -> None:
    uv_config = _pyproject()["tool"]["uv"]
    assert "cryptography>=50,<51" in uv_config["override-dependencies"]
    cryptography = next(package for package in _lock()["package"] if package["name"] == "cryptography")
    assert cryptography["version"].startswith("50.")


def test_r29_does_not_restore_the_removed_cli_extra() -> None:
    optional = _pyproject()["project"]["optional-dependencies"]
    assert "cli" not in optional
    for aggregate in ("all", "termux", "termux-all"):
        assert all("hermes-agent[cli]" not in item for item in optional[aggregate])


def test_r29_tests_use_the_worktree_mcp2_environment() -> None:
    assert importlib.metadata.version("mcp").startswith("2.")
    importlib.metadata.version("httpx2")
    distribution_root = Path(importlib.metadata.distribution("hermes-agent").locate_file("")).resolve()
    assert distribution_root == REPO_ROOT
