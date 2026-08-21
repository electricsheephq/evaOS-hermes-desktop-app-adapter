"""Guards for the r29 base cut owned by adapter issue #147."""

from __future__ import annotations

import importlib.metadata
import tomllib
from pathlib import Path

import hermes_cli
from packaging.requirements import Requirement
from packaging.version import Version


REPO_ROOT = Path(__file__).resolve().parents[1]


def _pyproject() -> dict:
    return tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))


def _lock() -> dict:
    return tomllib.loads((REPO_ROOT / "uv.lock").read_text(encoding="utf-8"))


def test_package_and_runtime_versions_match() -> None:
    project_version = _pyproject()["project"]["version"]
    assert project_version == hermes_cli.__version__


def test_r29_cryptography_lock_satisfies_declared_constraints() -> None:
    project = _pyproject()
    declared = Requirement(
        next(item for item in project["project"]["dependencies"] if item.startswith("cryptography"))
    )
    override = Requirement(
        next(
            item
            for item in project["tool"]["uv"]["override-dependencies"]
            if item.startswith("cryptography")
        )
    )
    cryptography = next(package for package in _lock()["package"] if package["name"] == "cryptography")
    locked = Version(cryptography["version"])
    assert locked in declared.specifier
    assert locked in override.specifier


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
