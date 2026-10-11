"""Local-file MCP arguments preserve approvals and keep file bytes out of inputs."""

import asyncio
import base64
import copy
import json
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from tools import mcp_local_files
from tools.mcp_local_files import expand_local_file_refs


@pytest.mark.parametrize("value", ["plain", "prefix local-file:/x", "local-file:/x suffix\n",
                                  "file:///x", "local-file:relative", "local-file:/x\x00", "local-file:/x\r"])
def test_non_references_are_identical(value):
    args = {"nested": [value, {"number": 1}]}
    expanded, error = expand_local_file_refs(args)
    assert expanded is args and error is None


@pytest.mark.parametrize("form", ["top", "nested", "triple-slash", "symlink", "unknown-mime"])
def test_expansion_round_trips_without_mutation(tmp_path, form):
    path = tmp_path / ("file.unknownextension" if form == "unknown-mime" else "file.pdf")
    data = b"\x00\xffexact file bytes"
    path.write_bytes(data)
    if form == "symlink":
        link = tmp_path / "link"
        link.symlink_to(path)
        path = link
    ref = f"local-file:{'//' if form == 'triple-slash' else ''}{path}"
    args = {"file": {"items": [ref]} if form == "nested" else ref}
    before = copy.deepcopy(args)
    expanded, error = expand_local_file_refs(args)
    assert error is None and args == before and expanded is not args
    uri = expanded["file"]["items"][0] if form == "nested" else expanded["file"]
    header, encoded = uri.split(",", 1)
    mime = "application/octet-stream" if form == "unknown-mime" else "application/pdf"
    assert header == f"data:{mime};base64"
    assert base64.b64decode(encoded) == data


@pytest.mark.parametrize("kind, reason", [("missing", "not found"), ("directory", "not a regular file")])
def test_file_errors_return_original_without_partial_expansion(tmp_path, kind, reason):
    good = tmp_path / "good.txt"
    good.write_bytes(b"good")
    bad = tmp_path / kind
    if kind == "directory":
        bad.mkdir()
    args = {"files": [f"local-file:{good}", f"local-file:{bad}"]}
    before = copy.deepcopy(args)
    expanded, error = expand_local_file_refs(args)
    assert expanded is args and args == before
    assert error.startswith(f"local-file reference '{bad}': ") and reason in error


@pytest.mark.parametrize("cap, limit, size", [("MAX_FILE_BYTES", 3, 4), ("MAX_CALL_BYTES", 7, 8)])
def test_caps_report_sizes(tmp_path, monkeypatch, cap, limit, size):
    monkeypatch.setattr(mcp_local_files, cap, limit)
    files = [tmp_path / "one", tmp_path / "two"]
    for path in files:
        path.write_bytes(b"1234")
    args = {"files": [f"local-file:{path}" for path in files]}
    expanded, error = expand_local_file_refs(args)
    assert expanded is args
    assert f"size {size} bytes" in error and f"cap {limit} bytes" in error


@pytest.mark.linux_only
def test_unreadable_file_reports_errno(tmp_path):
    if os.geteuid() == 0:
        pytest.skip("root bypasses file permissions")
    path = tmp_path / "private.txt"
    path.write_bytes(b"private")
    path.chmod(0)
    try:
        args = {"file": f"local-file:{path}"}
        expanded, error = expand_local_file_refs(args)
        assert expanded is args and "permission denied (EACCES)" in error
    finally:
        path.chmod(0o600)


@pytest.mark.parametrize("valid", [True, False])
def test_handler_expands_after_trust_before_server_acquisition(tmp_path, monkeypatch, valid):
    from tools import mcp_tool, mcp_tool_handlers as handlers, mcp_tool_loop

    path = tmp_path / "attachment.pdf"
    if valid:
        path.write_bytes(b"attachment")
    args = {"attachments": [f"local-file:{path}"]}
    seen = []
    monkeypatch.setattr(handlers, "_trust_gate_check", lambda s, t, a: seen.append(copy.deepcopy(a)))
    monkeypatch.setattr(handlers, "_check_circuit_breaker", lambda s: None)
    session = SimpleNamespace(call_tool=AsyncMock(return_value=SimpleNamespace(
        content=[SimpleNamespace(text="sent")], isError=False)))
    server = mcp_tool.MCPServerTask("local_files")
    server.session = session
    acquire = Mock(return_value=(server, None))
    monkeypatch.setattr(handlers, "_acquire_call_server", acquire)
    monkeypatch.setattr(mcp_tool_loop, "_run_on_mcp_loop", lambda c, timeout: asyncio.run(c() if callable(c) else c))
    result = json.loads(handlers._make_tool_handler("local_files", "send", 10)(args))
    assert seen == [args]
    if valid:
        assert result["result"] == "sent"
        sent = session.call_tool.call_args.kwargs["arguments"]["attachments"][0]
        assert sent == "data:application/pdf;base64," + base64.b64encode(b"attachment").decode("ascii")
        session.call_tool.assert_awaited_once()
    else:
        assert "local-file reference" in result["error"]
        acquire.assert_not_called()
        session.call_tool.assert_not_called()
