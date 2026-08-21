"""The shell installer must preserve uv's lock cutoff under UV_NO_CONFIG."""

from __future__ import annotations

import os
import re
import stat
import subprocess
import tomllib
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
INSTALL_SH = REPO_ROOT / "scripts" / "install.sh"


def test_install_sh_passes_the_lock_cutoff_to_uv_commands() -> None:
    source = (REPO_ROOT / "scripts" / "install.sh").read_text(encoding="utf-8")
    lock = tomllib.loads((REPO_ROOT / "uv.lock").read_text(encoding="utf-8"))
    pyproject = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8"))

    match = re.search(r'^UV_EXCLUDE_NEWER="([^"]+)"$', source, re.MULTILINE)
    assert match, "install.sh must define one explicit uv exclude-newer cutoff"
    cutoff = match.group(1)
    assert cutoff == lock["options"]["exclude-newer"]
    assert pyproject["tool"]["uv"]["exclude-newer"] == "14 days"

    assert 'sync --extra all --locked --exclude-newer "$UV_EXCLUDE_NEWER"' in source
    assert 'pip install --exclude-newer "$UV_EXCLUDE_NEWER"' in source
    assert '"${UV_EXCLUDE_NEWER_PACKAGE_ARGS[@]}"' in source
    for name, enabled in lock["options"]["exclude-newer-package"].items():
        value = "true" if enabled is True else "false" if enabled is False else str(enabled)
        assert f"--exclude-newer-package {name}={value}" in source


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

    source = INSTALL_SH.read_text(encoding="utf-8")
    functions = []
    for name in ("_uv_supports_exclude_newer_package", "install_uv"):
        match = re.search(
            rf"^{re.escape(name)}\(\) \{{.*?^\}}",
            source,
            re.MULTILINE | re.DOTALL,
        )
        assert match, f"could not extract {name}() from install.sh"
        # The live-system subprocess guard scans command text, including
        # comments. Strip comments from this isolated function harness so the
        # installer's documentation about ``hermes update`` is not mistaken
        # for an update command.
        functions.append(
            "\n".join(
                line
                for line in match.group(0).splitlines()
                if not line.lstrip().startswith("#")
            )
        )
    harness = "\n\n".join(functions) + "\ninstall_uv\n"
    env = dict(
        os.environ,
        HERMES_HOME=str(home),
        UV_LOG=str(uv_log),
        CURL_LOG=str(curl_log),
        PATH=f"{fake_bin}:{os.environ['PATH']}",
    )
    return subprocess.run(
        ["bash", "-c", "set -e\nDISTRO=linux\n"
         "log_info() { :; }; log_success() { :; }; log_warn() { echo \"$*\" >&2; }; "
         "log_error() { echo \"$*\" >&2; }; " + harness],
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )


def test_old_managed_uv_is_not_reused_with_unsupported_flags(tmp_path: Path) -> None:
    result = _run_install_uv(tmp_path, supports_exclude_newer=False)

    assert result.returncode != 0, result.stdout + result.stderr
    assert "--exclude-newer-package" in result.stderr
    assert "https://astral.sh/uv/install.sh" in (tmp_path / "curl.log").read_text()
    assert (tmp_path / "uv.log").read_text().splitlines() == ["pip install --help"]


def test_supported_managed_uv_is_reused_without_bootstrap(tmp_path: Path) -> None:
    result = _run_install_uv(tmp_path, supports_exclude_newer=True)

    assert result.returncode == 0, result.stdout + result.stderr
    assert not (tmp_path / "curl.log").exists()
