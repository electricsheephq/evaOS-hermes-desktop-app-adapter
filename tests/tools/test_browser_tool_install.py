"""Focused Chromium discovery contracts for agent-browser and Playwright."""

import os
import shutil
import sys

import pytest

from tools import browser_tool as bt
from tools import browser_tool_install as bt_install


@pytest.fixture(autouse=True)
def _isolated_chromium_discovery(monkeypatch, tmp_path):
    bt._cached_chromium_installed = None
    monkeypatch.setattr(os.path, "expanduser", lambda _: str(tmp_path))
    monkeypatch.setattr(shutil, "which", lambda *_args, **_kwargs: None)
    monkeypatch.delenv("AGENT_BROWSER_EXECUTABLE_PATH", raising=False)
    monkeypatch.delenv("PLAYWRIGHT_BROWSERS_PATH", raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "local-app-data"))
    yield
    bt._cached_chromium_installed = None


def _agent_browser_executable(build_dir):
    if sys.platform == "darwin":
        return (
            build_dir / "Google Chrome for Testing.app" / "Contents" / "MacOS"
            / "Google Chrome for Testing"
        )
    if sys.platform == "linux":
        return build_dir / "chrome"
    if sys.platform == "win32":
        return build_dir / "chrome.exe"
    pytest.skip(f"agent-browser does not provide a Chrome install layout for {sys.platform}")


def _assert_agent_browser_layout_is_detected(tmp_path):
    executable = _agent_browser_executable(
        tmp_path / ".agent-browser" / "browsers" / "chrome-140.0.7339.82"
    )
    executable.parent.mkdir(parents=True)
    executable.touch()
    executable.chmod(0o755)

    assert bt_install._chromium_installed() is True


@pytest.mark.linux_only
def test_linux_agent_browser_layout_is_detected(tmp_path):
    _assert_agent_browser_layout_is_detected(tmp_path)


@pytest.mark.macos_only
def test_macos_agent_browser_layout_is_detected(tmp_path):
    _assert_agent_browser_layout_is_detected(tmp_path)


@pytest.mark.windows_only
def test_windows_agent_browser_layout_is_detected(tmp_path):
    _assert_agent_browser_layout_is_detected(tmp_path)


def test_playwright_layout_remains_detected(monkeypatch, tmp_path):
    playwright_root = tmp_path / "playwright"
    (playwright_root / "chromium-1208").mkdir(parents=True)
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(playwright_root))

    assert bt_install._chromium_installed() is True


def test_missing_chromium_returns_false():
    assert bt_install._chromium_installed() is False


def test_agent_browser_executable_path_file_remains_detected(monkeypatch, tmp_path):
    executable = tmp_path / "custom-chrome"
    executable.touch()
    monkeypatch.setenv("AGENT_BROWSER_EXECUTABLE_PATH", str(executable))

    assert bt_install._chromium_installed() is True


def test_agent_browser_build_without_executable_returns_false(tmp_path):
    (tmp_path / ".agent-browser" / "browsers" / "chrome-140.0.7339.82").mkdir(parents=True)

    assert bt_install._chromium_installed() is False


def _assert_non_executable_agent_browser_build_is_rejected(tmp_path):
    executable = _agent_browser_executable(
        tmp_path / ".agent-browser" / "browsers" / "chrome-140.0.7339.82"
    )
    executable.parent.mkdir(parents=True)
    executable.touch(mode=0o644)

    assert bt_install._chromium_installed() is False


@pytest.mark.linux_only
def test_linux_agent_browser_build_requires_executable_permission(tmp_path):
    _assert_non_executable_agent_browser_build_is_rejected(tmp_path)


@pytest.mark.macos_only
def test_macos_agent_browser_build_requires_executable_permission(tmp_path):
    _assert_non_executable_agent_browser_build_is_rejected(tmp_path)
