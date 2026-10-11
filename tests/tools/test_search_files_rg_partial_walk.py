"""search_files(target="files") keeps rg's listing when the walk hit unreadable dirs.

``rg --files`` exits 2 whenever any directory in the walk is unreadable (EACCES),
even after printing every readable match. Discarding that listing made broad
file-name searches fail on any tree with a permission boundary (shared service
roots, migrated workspaces). Only permission-denied diagnostics are tolerated;
every other rg error still fails closed.
"""

import io
import os
from types import SimpleNamespace

import pytest

from tools.environments.local import LocalEnvironment
from tools.file_operations import ShellFileOperations
from tools.file_operations_search import _PARTIAL_WALK_WARNING, _rg_errors_are_only_eacces



def test_bounded_eacces_diagnostics_still_warn():
    """Merged stderr counts toward the fetch bound; a bound hit by permission diagnostics alone is
    reported as exit 0 and must still carry the partial-walk warning."""
    from tools.file_operations_common import ExecuteResult
    from tools.file_operations_search import _parse_search_output

    noise = "\n".join(f"rg: /blocked/{i}: Permission denied (os error 13)" for i in range(5))
    result = _parse_search_output(ExecuteResult(stdout=noise, exit_code=0), "content", 2, 0, 0)
    assert not result.error and result.total_count == 0
    assert _PARTIAL_WALK_WARNING in (result.warning or "")


def test_eacces_classifier():
    assert _rg_errors_are_only_eacces("rg: /a/b: Permission denied (os error 13)\n")
    assert _rg_errors_are_only_eacces("rg: /a: Permission denied (os error 13)\nrg: /c: Permission denied (os error 13)")
    assert not _rg_errors_are_only_eacces("")
    assert not _rg_errors_are_only_eacces("rg: /a: Permission denied (os error 13)\nrg: error parsing glob '[': unclosed character class")
    assert not _rg_errors_are_only_eacces("rg: /a: Input/output error (os error 5)")


@pytest.mark.linux_only
def test_non_eacces_after_stderr_sample_fails_closed(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_NATIVE_FILE_READ", "1")
    ops = ShellFileOperations(LocalEnvironment(cwd=str(tmp_path)), cwd=str(tmp_path))
    eacces = b"rg: /blocked: Permission denied (os error 13)\n"
    proc = SimpleNamespace(
        stdout=io.BytesIO(b"readable.txt\n"),
        stderr=io.BytesIO(eacces * 200 + b"rg: /missing: No such file or directory (os error 2)\n"),
        returncode=2, poll=lambda: 2, wait=lambda: 2,
    )
    monkeypatch.setattr("tools.file_operations_search.subprocess.Popen", lambda *a, **kw: proc)
    captured = ops._run_rg_native(["rg", "--files"], 51, 60, capture_stderr=True)
    assert len(captured.stderr.splitlines()) == 200
    assert _rg_errors_are_only_eacces(captured.stderr)
    monkeypatch.setattr(ops, "_run_rg_bounded", lambda *a, **kw: captured)
    result = ops._search_files_rg("*.txt", str(tmp_path), 50, 0, rg_executable="rg")
    assert result.error is not None
    assert result.files == []


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


@pytest.mark.linux_only
def test_matches_beside_unreadable_dir_are_returned_with_warning(ops, blocked_tree):
    result = ops.search("probe-target*", path=str(blocked_tree), target="files")
    assert result.error is None
    assert result.files == [str(blocked_tree / "readable" / "probe-target.txt")]
    assert result.warning == _PARTIAL_WALK_WARNING


@pytest.mark.linux_only
def test_zero_matches_beside_unreadable_dir_is_an_empty_result_not_an_error(ops, blocked_tree):
    result = ops.search("no-such-name*", path=str(blocked_tree), target="files")
    assert result.error is None
    assert result.files == []
    assert result.warning == _PARTIAL_WALK_WARNING


@pytest.mark.linux_only
def test_clean_tree_has_no_warning(ops, blocked_tree):
    result = ops.search("probe-target*", path=str(blocked_tree / "readable"), target="files")
    assert result.error is None and result.warning is None
    assert len(result.files) == 1


@pytest.mark.linux_only
def test_content_search_zero_matches_beside_unreadable_dir_is_empty_not_error(ops, blocked_tree):
    result = ops.search("zz-no-such-content", path=str(blocked_tree), target="content")
    assert result.error is None
    assert result.matches == []
    assert result.warning == _PARTIAL_WALK_WARNING


@pytest.mark.linux_only
@pytest.mark.parametrize("output_mode", ["content", "files_only", "count"])
def test_content_match_beside_unreadable_dir_keeps_warning(ops, blocked_tree, output_mode):
    result = ops.search("x", path=str(blocked_tree), target="content", output_mode=output_mode)
    assert result.error is None
    assert result.total_count == 1
    expected_path = str(blocked_tree / "readable" / "probe-target.txt")
    if output_mode == "content":
        assert [(m.path, m.line_number, m.content) for m in result.matches] == [(expected_path, 1, "x")]
    elif output_mode == "files_only":
        assert result.files == [expected_path]
    else:
        assert result.counts == {expected_path: 1}
    assert result.warning == _PARTIAL_WALK_WARNING


@pytest.mark.linux_only
@pytest.mark.parametrize("target,pattern", [("files", "probe-target*"), ("content", "x")])
def test_multipath_recovery_preserves_partial_walk_warning(ops, blocked_tree, target, pattern):
    result = ops.search(pattern, path=f"{blocked_tree}, {blocked_tree / 'missing'}", target=target)
    assert result.error is None
    assert result.total_count == 1
    assert _PARTIAL_WALK_WARNING in result.warning
    assert "searched 1 that exist; skipped missing:" in result.warning
