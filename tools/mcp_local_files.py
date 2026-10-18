"""Expand short local file references only at the MCP dispatch boundary."""

import base64
import errno
import json
import mimetypes
import os
import re
import stat

_REFERENCE = re.compile(r"local-file:(?://)?(/[^\x00\r\n]+)")
# Fixed caps, not a config surface. Raw bytes; base64 inflates 4/3, so a full call (17 MiB ->
# ~22.7 MiB encoded) stays under Gmail's 25 MB message limit with room for headers.
MAX_FILE_BYTES = 15 * 1024 * 1024
MAX_CALL_BYTES = 17 * 1024 * 1024
# Leave room for the JSON-RPC envelope under the hosted connector's ~100 KB body limit.
HTTP_MAX_REQUEST_BYTES = 96 * 1024
HTTP_MAX_FILE_BYTES = HTTP_MAX_CALL_BYTES = HTTP_MAX_REQUEST_BYTES * 3 // 4
_LIMIT_GUIDANCE = (
    "Do not retry, re-encode, split the file, or use a public file host; "
    "tell the user the file cannot be attached this way."
)


def expand_local_file_refs(args: dict, *, http: bool) -> tuple[dict, str | None]:
    """Return expanded arguments, or the original arguments on a file or size error."""
    per_file, per_call = (HTTP_MAX_FILE_BYTES, HTTP_MAX_CALL_BYTES) if http else (MAX_FILE_BYTES, MAX_CALL_BYTES)
    total = 0

    def walk(value):
        nonlocal total
        if isinstance(value, (dict, list)):
            items = value.items() if isinstance(value, dict) else enumerate(value)
            expanded = value
            for key, item in items:
                replacement = walk(item)
                if replacement is not item:
                    if expanded is value:
                        expanded = value.copy()
                    expanded[key] = replacement
            return expanded
        match = _REFERENCE.fullmatch(value) if isinstance(value, str) else None
        if match is None:
            return value
        path = match[1]
        prefix = f"local-file reference '{path}': "
        try:
            resolved = os.path.realpath(path)
            info = os.stat(resolved)
            if not stat.S_ISREG(info.st_mode):
                raise ValueError(prefix + "not a regular file")
            if info.st_size > per_file:
                if not http:
                    raise ValueError(prefix + f"size {info.st_size} bytes exceeds per-file cap {per_file} bytes")
                raise ValueError(
                    f"local-file attachments too large: size {info.st_size} bytes exceeds per-file "
                    f"cap {per_file / 1024:g} KB ({per_file} bytes). {_LIMIT_GUIDANCE}"
                )
            with open(resolved, "rb") as stream:
                data = stream.read(per_file + 1)
        except OSError as exc:
            code = errno.errorcode.get(exc.errno, "UNKNOWN")
            reason = {errno.ENOENT: "not found", errno.EACCES: "permission denied"}.get(exc.errno, "OS error")
            raise ValueError(prefix + f"{reason} ({code})") from None
        if len(data) > per_file:
            if not http:
                raise ValueError(prefix + f"size {len(data)} bytes exceeds per-file cap {per_file} bytes")
            raise ValueError(
                f"local-file attachments too large: size {len(data)} bytes exceeds per-file "
                f"cap {per_file / 1024:g} KB ({per_file} bytes). {_LIMIT_GUIDANCE}"
            )
        total += len(data)
        if total > per_call:
            if not http:
                raise ValueError(prefix + f"total size {total} bytes exceeds total cap {per_call} bytes")
            raise ValueError(
                f"local-file attachments too large: total size {total} bytes exceeds total "
                f"cap {per_call / 1024:g} KB ({per_call} bytes). {_LIMIT_GUIDANCE}"
            )
        mime = mimetypes.guess_type(resolved)[0] or "application/octet-stream"
        return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"

    try:
        expanded = walk(args)
        if http and expanded is not args:
            request_bytes = len(json.dumps(expanded, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
            if request_bytes > HTTP_MAX_REQUEST_BYTES:
                return args, (
                    f"local-file attachments too large: the request would be {request_bytes} bytes; "
                    "the hosted connector rejects requests over about 100 KB (HTTP 413), "
                    f"which is about 70 KB of files in total. {_LIMIT_GUIDANCE}"
                )
        return expanded, None
    except ValueError as exc:
        return args, str(exc)
