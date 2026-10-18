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
    expanded, error = expand_local_file_refs(args, http=False)
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
    expanded, error = expand_local_file_refs(args, http=False)
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
    expanded, error = expand_local_file_refs(args, http=False)
    assert expanded is args and args == before
    assert error.startswith(f"local-file reference '{bad}': ") and reason in error


@pytest.mark.parametrize("cap, limit, size", [("MAX_FILE_BYTES", 3, 4), ("MAX_CALL_BYTES", 7, 8)])
def test_caps_report_sizes(tmp_path, monkeypatch, cap, limit, size):
    monkeypatch.setattr(mcp_local_files, cap, limit)
    files = [tmp_path / "one", tmp_path / "two"]
    for path in files:
        path.write_bytes(b"1234")
    args = {"files": [f"local-file:{path}" for path in files]}
    expanded, error = expand_local_file_refs(args, http=False)
    assert expanded is args
    assert f"size {size} bytes" in error and f"cap {limit} bytes" in error


@pytest.mark.parametrize("http, case", [
    (True, "per-file"), (True, "per-call"),
    (True, "request-under"), (True, "request-at"), (True, "request-over"),
    (True, "no-reference"), (False, "no-reference"), (False, "large-file"),
])
def test_attachment_limits_follow_transport(tmp_path, monkeypatch, http, case):
    path = tmp_path / "attachment.txt"
    data = b"x" * ({"per-file": 72 * 1024 + 1, "large-file": 200 * 1024}.get(case, 1))
    path.write_bytes(data)
    args = {"file": f"local-file:{path}", "body": "é"}
    expected = {"file": "data:text/plain;base64," + base64.b64encode(data).decode("ascii"), "body": "é"}
    if case.startswith("request-"):
        budget = mcp_local_files.HTTP_MAX_REQUEST_BYTES
        overhead = len(json.dumps(expected, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
        delta = {"request-under": -1, "request-at": 0, "request-over": 1}[case]
        args["body"] += "t" * (budget - overhead + delta)
        expected["body"] = args["body"]
    elif case == "per-file":
        # The stat guard must reject before any attempt to read the file.
        monkeypatch.setattr(mcp_local_files, "open", Mock(side_effect=AssertionError("file read")), raising=False)
    elif case == "per-call":
        monkeypatch.setattr(mcp_local_files, "HTTP_MAX_CALL_BYTES", 1)
        args["files"] = [args["file"]]
    if case == "no-reference":
        args = {"body": "text" * 30_000}
    before = copy.deepcopy(args)
    expanded, error = expand_local_file_refs(args, http=http)
    assert args == before
    if case in {"per-file", "per-call", "request-over"}:
        assert expanded is args
        assert "local-file attachments too large" in error
        assert str(path) not in error and "x" * 100 not in error
        assert error.endswith(mcp_local_files._LIMIT_GUIDANCE)
        if case == "per-file":
            assert "72 KB (73728 bytes)" in error
        elif case == "per-call":
            assert "total size 2 bytes exceeds total cap" in error
        else:
            assert f"the request would be {budget + 1} bytes" in error
            assert "100 KB (HTTP 413)" in error
    elif case == "no-reference":
        assert expanded is args and error is None
    else:
        assert expanded == expected and error is None


@pytest.mark.linux_only
def test_unreadable_file_reports_errno(tmp_path):
    if os.geteuid() == 0:
        pytest.skip("root bypasses file permissions")
    path = tmp_path / "private.txt"
    path.write_bytes(b"private")
    path.chmod(0)
    try:
        args = {"file": f"local-file:{path}"}
        expanded, error = expand_local_file_refs(args, http=False)
        assert expanded is args and "permission denied (EACCES)" in error
    finally:
        path.chmod(0o600)


@pytest.mark.parametrize("transport, kind", [
    (True, "valid"), (False, "valid"), (True, "missing"), (False, "missing"),
    (True, "oversized"), (False, "oversized"),
    ("unknown", "oversized"), ("noncallable", "oversized"),
])
def test_registry_dispatch_expands_after_trust_and_transport_acquisition(tmp_path, monkeypatch, transport, kind):
    from tools import mcp_tool, mcp_tool_handlers as handlers, mcp_tool_loop
    from tools.registry import ToolRegistry

    path = tmp_path / "attachment.pdf"
    data = b"attachment" if kind == "valid" else b"x" * (200 * 1024)
    if kind != "missing":
        path.write_bytes(data)
    args = {"attachments": [f"local-file:{path}"]}
    seen = []
    monkeypatch.setattr(handlers, "_trust_gate_check", lambda s, t, a: seen.append(copy.deepcopy(a)))
    monkeypatch.setattr(handlers, "_check_circuit_breaker", lambda s: None)
    bump = Mock()
    monkeypatch.setattr(mcp_tool, "_bump_server_error", bump)
    monkeypatch.setattr(mcp_tool, "_server_error_counts", {})
    monkeypatch.setattr(mcp_tool, "_server_errors_all_application", {})
    monkeypatch.setattr(mcp_tool, "_server_breaker_opened_at", {})
    session = SimpleNamespace(call_tool=AsyncMock(return_value=SimpleNamespace(
        content=[SimpleNamespace(text="sent")], isError=False)))
    server = SimpleNamespace(session=session, _rpc_lock=asyncio.Lock())
    if isinstance(transport, bool):
        server._is_http = Mock(return_value=transport)
    elif transport == "noncallable":
        server._is_http = False
    acquire = Mock(side_effect=lambda *a: (seen.append("acquired") or server, None))
    monkeypatch.setattr(handlers, "_acquire_call_server", acquire)
    monkeypatch.setattr(mcp_tool_loop, "_run_on_mcp_loop", lambda c, timeout: asyncio.run(c() if callable(c) else c))
    registry = ToolRegistry()
    registry.register("test_mcp_send", "mcp-local-files", {}, handlers._make_tool_handler("local_files", "send", 10))
    result = json.loads(registry.dispatch("test_mcp_send", args))
    assert seen == [args, "acquired"]
    acquire.assert_called_once_with("local_files", 10)
    bump.assert_not_called()
    if kind == "valid" or (kind == "oversized" and transport is False):
        assert result["result"] == "sent"
        sent = session.call_tool.call_args.kwargs["arguments"]["attachments"][0]
        assert sent == "data:application/pdf;base64," + base64.b64encode(data).decode("ascii")
        session.call_tool.assert_awaited_once()
    else:
        assert ("local-file reference" if kind == "missing" else "local-file attachments too large") in result["error"]
        session.call_tool.assert_not_called()
        session.call_tool.assert_not_awaited()
