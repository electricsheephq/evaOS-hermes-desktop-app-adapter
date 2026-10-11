"""search_files(target="files") keeps rg's listing when the walk hit unreadable dirs.

``rg --files`` exits 2 whenever any directory in the walk is unreadable (EACCES),
even after printing every readable match. Discarding that listing made broad
file-name searches fail on any tree with a permission boundary (shared service
roots, migrated workspaces). Only permission-denied diagnostics are tolerated;
every other rg error still fails closed.
"""

import os

import pytest

from tools.environments.local import LocalEnvironment
from tools.file_operations import ShellFileOperations
from tools.file_operations_search import _PARTIAL_WALK_WARNING, _rg_errors_are_only_eacces

pytestmark = pytest.mark.platforms("posix")


def test_eacces_classifier():
    assert _rg_errors_are_only_eacces("rg: /a/b: Permission denied (os error 13)\n")
    assert _rg_errors_are_only_eacces("rg: /a: Permission denied (os error 13)\nrg: /c: Permission denied (os error 13)")
    assert not _rg_errors_are_only_eacces("")
    assert not _rg_errors_are_only_eacces("rg: /a: Permission denied (os error 13)\nrg: error parsing glob '[': unclosed character class")
    assert not _rg_errors_are_only_eacces("rg: /a: Input/output error (os error 5)")


@pytest.fixture
def blocked_tree(tmp_path):
    if os.geteuid() == 0:
        pytest.skip("root can read a 0000 directory")
    (tmp_path / "readable").mkdir()
    (tmp_path / "readable" / "probe-target.txt").write_text("x")
    blocked = tmp_path / "blocked"
    blocked.mkdir()
    (blocked / "probe-target-hidden.txt").write_text("x")
    blocked.chmod(0)
    yield tmp_path
    blocked.chmod(0o755)


@pytest.fixture
def ops(blocked_tree, monkeypatch):
    monkeypatch.setenv("HERMES_NATIVE_FILE_READ", "1")
    o = ShellFileOperations(LocalEnvironment(cwd=str(blocked_tree)), cwd=str(blocked_tree))
    if not o._has_command("rg"):
        pytest.skip("requires ripgrep")
    return o


def test_matches_beside_unreadable_dir_are_returned_with_warning(ops, blocked_tree):
    result = ops.search("probe-target*", path=str(blocked_tree), target="files")
    assert result.error is None
    assert result.files == [str(blocked_tree / "readable" / "probe-target.txt")]
    assert result.warning == _PARTIAL_WALK_WARNING


def test_zero_matches_beside_unreadable_dir_is_an_empty_result_not_an_error(ops, blocked_tree):
    result = ops.search("no-such-name*", path=str(blocked_tree), target="files")
    assert result.error is None
    assert result.files == []
    assert result.warning == _PARTIAL_WALK_WARNING


def test_clean_tree_has_no_warning(ops, blocked_tree):
    result = ops.search("probe-target*", path=str(blocked_tree / "readable"), target="files")
    assert result.error is None and result.warning is None
    assert len(result.files) == 1


def test_content_search_zero_matches_beside_unreadable_dir_is_empty_not_error(ops, blocked_tree):
    result = ops.search("zz-no-such-content", path=str(blocked_tree), target="content")
    assert result.error is None
    assert result.matches == []
    assert result.warning == _PARTIAL_WALK_WARNING
