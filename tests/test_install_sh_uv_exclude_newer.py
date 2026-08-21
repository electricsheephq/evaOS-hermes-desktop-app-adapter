"""Behavioral coverage for the shell installer's managed uv capability gate."""

from __future__ import annotations

import os
import stat
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
INSTALL_SH = REPO_ROOT / "scripts" / "install.sh"

def _run_install_uv(
    tmp_path: Path, *, supports_exclude_newer: bool
) -> subprocess.CompletedProcess[str]:
    """Run install_uv with a local uv stub and a curl stub that cannot download."""
    home = tmp_path / "hermes"
    uv = home / "bin" / "uv"
    uv.parent.mkdir(parents=True)
    uv_log = tmp_path / "uv.log"
    uv.write_text(
        "#!/bin/sh\n"
        "printf '%s\\n' \"$*\" >>\"$UV_LOG\"\n"
        "case \"$*\" in\n"
        "  --version) echo 'uv 0.1.0' ;;\n"
        f"  'pip install --help') "
        f"{'echo --exclude-newer-package' if supports_exclude_newer else 'echo old-help'} ;;\n"
        "  *) exit 42 ;;\n"
        "esac\n",
        encoding="utf-8",
    )
    uv.chmod(uv.stat().st_mode | stat.S_IXUSR)

    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    curl_log = tmp_path / "curl.log"
    (fake_bin / "curl").write_text(
        "#!/bin/sh\n"
        "printf '%s\\n' \"$*\" >\"$CURL_LOG\"\n"
        "exit 97\n",
        encoding="utf-8",
    )
    (fake_bin / "curl").chmod(0o700)

    env = dict(
        os.environ,
        HERMES_HOME=str(home),
        HERMES_INSTALL_TEST_ENTRYPOINT="install_uv",
        UV_LOG=str(uv_log),
        CURL_LOG=str(curl_log),
        PATH=f"{fake_bin}:{os.environ['PATH']}",
    )
    return subprocess.run(
        ["bash", str(INSTALL_SH)],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )


def test_old_managed_uv_is_not_reused_with_unsupported_flags(tmp_path: Path) -> None:
    result = _run_install_uv(tmp_path, supports_exclude_newer=False)

    assert result.returncode != 0, result.stdout + result.stderr
    assert "--exclude-newer-package" in result.stdout
    assert "https://astral.sh/uv/install.sh" in (tmp_path / "curl.log").read_text()
    assert (tmp_path / "uv.log").read_text().splitlines() == ["pip install --help"]


def test_supported_managed_uv_is_reused_without_bootstrap(tmp_path: Path) -> None:
    result = _run_install_uv(tmp_path, supports_exclude_newer=True)

    assert result.returncode == 0, result.stdout + result.stderr
    assert not (tmp_path / "curl.log").exists()
