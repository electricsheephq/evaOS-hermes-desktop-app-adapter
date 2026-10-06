"""Tests for the agent-browser socket dir budget in ``_prepare_session_socket_dir`` —
the dir layout ``<root>/agent-browser-<session>/<session>.sock`` must keep the final
socket path under agent-browser's 103-byte cap (#122786)."""

import os

import pytest

from tools import browser_tool_session as session_mod


def _capture_root(monkeypatch, tmp_path):
    """Point ``_socket_safe_tmpdir`` at a controlled root, recording the requested budget."""
    seen = []

    def fake(max_len=None):
        seen.append(max_len)
        return str(tmp_path)

    monkeypatch.setattr("tools.browser_tool._socket_safe_tmpdir", fake)
    monkeypatch.setattr(
        "tools.browser_tool_lifecycle._write_owner_pid", lambda *_a: None
    )
    return seen


class TestPrepareSessionSocketDir:
    def test_short_session_budget_clamped_to_default(self, monkeypatch, tmp_path):
        seen = _capture_root(monkeypatch, tmp_path)
        socket_dir = session_mod._prepare_session_socket_dir("h_ab12cd34ef")
        assert socket_dir == str(tmp_path / "agent-browser-h_ab12cd34ef")
        # Raw budget 103 - 1 - len(suffix) = 58, clamped to SOCKET_TMPDIR_MAX_LEN = 50: a
        # short name must never LOOSEN the default budget, or a 51-58 char scratch root
        # would move local socket dirs into scratch where reaper/teardown can't find them.
        assert seen == [50]

    def test_long_cloud_session_name_requests_tight_budget(self, monkeypatch, tmp_path):
        seen = _capture_root(monkeypatch, tmp_path)
        # plugins/browser/_common.py:: _session_name -> f"hermes_{task_id}_{hex8}"
        name = "hermes_20260925_163836_07df261a_38488bd0_ab12cd34"
        session_mod._prepare_session_socket_dir(name)
        suffix = f"agent-browser-{name}/{name}.sock"
        # far below SOCKET_TMPDIR_MAX_LEN, so the clamp leaves the tight budget intact
        assert seen == [103 - 1 - len(suffix)]

    def test_dir_created_owner_only(self, monkeypatch, tmp_path):
        import os

        _capture_root(monkeypatch, tmp_path)
        socket_dir = session_mod._prepare_session_socket_dir("h_ab12cd34ef")
        assert os.path.isdir(socket_dir)
        assert (os.stat(socket_dir).st_mode & 0o777) == 0o700

    def test_owner_pid_claimed_under_session_name(self, monkeypatch, tmp_path):
        claims = []
        monkeypatch.setattr(
            "tools.browser_tool._socket_safe_tmpdir", lambda max_len=None: str(tmp_path)
        )
        monkeypatch.setattr(
            "tools.browser_tool_lifecycle._write_owner_pid",
            lambda dirpath, name: claims.append((dirpath, name)),
        )
        session_mod._prepare_session_socket_dir("h_ab12cd34ef")
        assert claims == [
            (str(tmp_path / "agent-browser-h_ab12cd34ef"), "h_ab12cd34ef")
        ]


class TestSessionSocketRootAgreement:
    """Producer, teardown and the reaper must agree on the socket dir root (production
    follow-up to #122786: teardown and the reaper looked under the default-budget root
    while the producer had placed long-name dirs in the /tmp fallback, so the rmtree and
    the pid-file kill silently did nothing)."""

    # Scratch root lengths reported from real fleets, including the 51-58 range where an
    # unclamped 58-char budget would diverge from the default SOCKET_TMPDIR_MAX_LEN=50.
    SCRATCH_LENGTHS = (39, 40, 41, 42, 43, 45, 46, 47, 50, 51, 57, 58)

    # Real session-name shapes: local/real-profile/cdp ``<prefix>_<hex10>``, the
    # lightpanda fallback ``h_cfb_<hex8>``, and cloud ``hermes_<task_id>_<hex8>`` where
    # subagent task ids look like ``sa-1-e74bf0ca`` — 13 chars, not 12.
    NAMES = (
        "h_ab12cd34ef",
        "rp_0011223344",
        "cdp_0011223344",
        "h_cfb_00112233",
        "hermes_sa-1-e74bf0ca_ab12cd34",                    # 13-char task id
        "hermes_sa-1-" + "a" * 17 + "_ab12cd34",            # 22-char task id
        "hermes_sa-1-" + "a" * 28 + "_ab12cd34",            # 33-char task id
    )

    def _scratch(self, monkeypatch, length, fallback="/tmp"):
        """Controlled temp-root selection; no host emulation or filesystem writes."""
        import hermes_constants
        from tools import browser_tool as bt

        scratch = "/" + "s" * (length - 1)
        def select(max_len=None):
            budget = hermes_constants.SOCKET_TMPDIR_MAX_LEN if max_len is None else max_len
            return scratch if len(scratch.encode()) <= budget else fallback

        monkeypatch.setattr(bt, "_socket_safe_tmpdir", select)

    def test_reaper_roots_cover_every_producer_root(self, monkeypatch):
        """Whatever the scratch length, each producer root is one of the two roots the
        orphan reaper scans (default-budget root or the /tmp fallback)."""
        from tools import browser_tool as bt

        for length in self.SCRATCH_LENGTHS:
            self._scratch(monkeypatch, length)
            reaper_roots = {bt._socket_safe_tmpdir(), bt._socket_safe_tmpdir(max_len=0)}
            for name in self.NAMES:
                root = session_mod._session_socket_root(name)
                assert root in reaper_roots, (
                    length,
                    name,
                )
                daemon_sock = "default.sock" if name.startswith("hermes_") else f"{name}.sock"
                assert len(f"{root}/agent-browser-{name}/{daemon_sock}".encode()) <= 103

    @pytest.mark.parametrize("scratch_len", [39, 42, 43, 47, 50, 51, 57, 58])
    @pytest.mark.parametrize("task_id_len", [13, 22, 33])
    def test_cloud_layout_path_and_root_agreement(self, monkeypatch, scratch_len, task_id_len):
        """Exercise the real producer, teardown and reaper with only I/O replaced."""
        import fnmatch
        from tools import browser_tool_lifecycle as lifecycle

        self._scratch(monkeypatch, scratch_len)
        name = f"hermes_{'a' * task_id_len}_ab12cd34"
        monkeypatch.setattr(os, "makedirs", lambda *_a, **_kw: None)
        monkeypatch.setattr(lifecycle, "_write_owner_pid", lambda *_a: None)
        socket_dir = session_mod._prepare_session_socket_dir(name)
        socket_path = f"{socket_dir}/default.sock"
        assert len(socket_path.encode()) <= 103, (scratch_len, task_id_len, socket_path)

        removed = []
        killed = []
        monkeypatch.setattr(lifecycle, "_forget_session_tracking", lambda *_a, **_kw: None)
        monkeypatch.setattr(os.path, "exists", lambda path: path == socket_dir)
        monkeypatch.setattr(lifecycle, "_kill_verified_daemon", lambda path, _name: killed.append(path))
        monkeypatch.setattr(lifecycle.shutil, "rmtree", lambda path, **_kw: removed.append(path))
        lifecycle._release_session_resources("matrix", {"session_name": name, "bb_session_id": None})
        assert killed == removed == [socket_dir]

        candidates = []
        reaped = []
        def scan(pattern):
            candidates.append(os.path.dirname(pattern))
            return [socket_dir] if fnmatch.fnmatch(socket_dir, pattern) else []
        monkeypatch.setattr("glob.glob", scan)
        monkeypatch.setattr(lifecycle, "_best_effort", lambda *_a: None)
        monkeypatch.setattr(lifecycle, "_reap_socket_dir", lambda path, *_a: reaped.append(path) or False)
        lifecycle._reap_orphaned_browser_sessions()
        assert os.path.dirname(socket_dir) in candidates
        assert reaped == [socket_dir]

    def test_teardown_removes_dir_from_producer_root(self, monkeypatch, tmp_path):
        """The 51-char scratch case from production: the clamped budget still falls back
        to /tmp, and ``_release_session_resources`` must look there too, or its rmtree
        silently no-ops and the dir leaks to the grace sweep."""
        import os
        import shutil

        from tools import browser_tool_lifecycle as lifecycle

        self._scratch(monkeypatch, 51, fallback=str(tmp_path))
        monkeypatch.setattr(
            "tools.browser_tool_lifecycle._write_owner_pid", lambda *_a: None
        )
        socket_dir = session_mod._prepare_session_socket_dir("h_ab12cd34ef")
        try:
            assert socket_dir == str(tmp_path / "agent-browser-h_ab12cd34ef")
            assert os.path.isdir(socket_dir)
            lifecycle._release_session_resources(
                "t", {"session_name": "h_ab12cd34ef", "bb_session_id": None}
            )
            assert not os.path.exists(socket_dir)
        finally:
            shutil.rmtree(socket_dir, ignore_errors=True)
