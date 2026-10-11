"""Expand short local file references only at the MCP dispatch boundary."""

import base64
import errno
import mimetypes
import os
import re
import stat

_REFERENCE = re.compile(r"local-file:(?://)?(/[^\x00\r\n]+)")
# Fixed caps, not a config surface. Raw bytes; base64 inflates 4/3, so a full call (17 MiB ->
# ~22.7 MiB encoded) stays under Gmail's 25 MB message limit with room for headers.
MAX_FILE_BYTES = 15 * 1024 * 1024
MAX_CALL_BYTES = 17 * 1024 * 1024


def expand_local_file_refs(args: dict) -> tuple[dict, str | None]:
    """Return expanded arguments, or the original arguments on any file error."""
    per_file, per_call = MAX_FILE_BYTES, MAX_CALL_BYTES
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
                raise ValueError(prefix + f"size {info.st_size} bytes exceeds per-file cap {per_file} bytes")
            with open(resolved, "rb") as stream:
                data = stream.read(per_file + 1)
        except OSError as exc:
            code = errno.errorcode.get(exc.errno, "UNKNOWN")
            reason = {errno.ENOENT: "not found", errno.EACCES: "permission denied"}.get(exc.errno, "OS error")
            raise ValueError(prefix + f"{reason} ({code})") from None
        if len(data) > per_file:
            raise ValueError(prefix + f"size {len(data)} bytes exceeds per-file cap {per_file} bytes")
        total += len(data)
        if total > per_call:
            raise ValueError(prefix + f"total size {total} bytes exceeds total cap {per_call} bytes")
        mime = mimetypes.guess_type(resolved)[0] or "application/octet-stream"
        return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"

    try:
        return walk(args), None
    except ValueError as exc:
        return args, str(exc)
