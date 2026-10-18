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
    assert f"size {size} bytes" in error and f"({limit} bytes)" in error
    assert f"{limit / 1024:g} KB" in error
    assert all(str(path) not in error for path in files)


@pytest.mark.parametrize("size, body_size, rejected", [
    (111_097, 0, True),
    (23_301, 0, False),
    (30_000, 60_000, True),
])
def test_attachment_request_limits(tmp_path, monkeypatch, size, body_size, rejected):
    path = tmp_path / "attachment.txt"
    data = b"x" * size
    path.write_bytes(data)
    args = {"file": f"local-file:{path}", "body": "t" * body_size}
    before = copy.deepcopy(args)
    if size == 111_097:
        # The stat guard must reject before any attempt to read the file.
        monkeypatch.setattr(mcp_local_files, "open", Mock(side_effect=AssertionError("file read")), raising=False)
    expanded, error = expand_local_file_refs(args)
    assert args == before
    if rejected:
        assert expanded is args
        assert "local-file attachments too large" in error
        assert str(path) not in error and "x" * 100 not in error
        assert "Do not retry, re-encode, split the file, or use a public file host" in error
        if size == 111_097:
            assert "72 KB" in error
        else:
            assert "100 KB (HTTP 413)" in error
    else:
        assert error is None
        assert base64.b64decode(expanded["file"].split(",", 1)[1]) == data


@pytest.mark.parametrize("extra_byte", [0, 1])
def test_serialized_request_boundary(tmp_path, monkeypatch, extra_byte):
    path = tmp_path / "attachment.txt"
    path.write_bytes(b"x")
    budget = 128
    monkeypatch.setattr(mcp_local_files, "MAX_REQUEST_BYTES", budget, raising=False)
    expected = {"file": "data:text/plain;base64,eA==", "body": "é"}
    overhead = len(json.dumps(expected, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    expected["body"] += "t" * (budget - overhead + extra_byte)
    args = {"file": f"local-file:{path}", "body": expected["body"]}
    expanded, error = expand_local_file_refs(args)
    if extra_byte:
        assert expanded is args
        assert f"the request would be {budget + 1} bytes" in error
        assert str(path) not in error
    else:
        assert expanded == expected and error is None


def test_large_arguments_without_references_are_unchanged(monkeypatch):
    monkeypatch.setattr(mcp_local_files, "MAX_REQUEST_BYTES", 1, raising=False)
    args = {"body": "text" * 30_000}
    expanded, error = expand_local_file_refs(args)
    assert expanded is args and error is None


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


@pytest.mark.parametrize("kind", ["valid", "missing", "oversized"])
def test_handler_expands_after_trust_before_server_acquisition(tmp_path, monkeypatch, kind):
    from tools import mcp_tool, mcp_tool_handlers as handlers, mcp_tool_loop

    path = tmp_path / "attachment.pdf"
    if kind != "missing":
        path.write_bytes(b"attachment" if kind == "valid" else b"x" * 30_000)
    args = {"attachments": [f"local-file:{path}"]}
    if kind == "oversized":
        args["body"] = "t" * 60_000
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
    if kind == "valid":
        assert result["result"] == "sent"
        sent = session.call_tool.call_args.kwargs["arguments"]["attachments"][0]
        assert sent == "data:application/pdf;base64," + base64.b64encode(b"attachment").decode("ascii")
        session.call_tool.assert_awaited_once()
    else:
        assert ("local-file reference" if kind == "missing" else "local-file attachments too large") in result["error"]
        acquire.assert_not_called()
        session.call_tool.assert_not_called()
        session.call_tool.assert_not_awaited()
