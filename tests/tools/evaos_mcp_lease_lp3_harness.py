"""Root-run LP-3 harness for a real internal MCP lease.

This script emits only bounded metadata and a response digest. It never prints
the broker endpoint, lease URL, request headers, tokens, or tool payload.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
from typing import Any

import yaml


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile-home", required=True)
    parser.add_argument("--managed-config", required=True)
    parser.add_argument("--server", required=True)
    parser.add_argument("--read-tool", required=True)
    parser.add_argument("--read-args-json-file", required=True)
    return parser


def _managed_server(config_path: Path, server_name: str) -> dict[str, Any]:
    document = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    servers = document.get("mcp_servers") if isinstance(document, dict) else None
    config = servers.get(server_name) if isinstance(servers, dict) else None
    if not isinstance(config, dict) or config.get("auth") != "evaos_lease":
        raise ValueError("selected server is not a managed evaOS lease entry")
    return config


def _read_args(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("read-tool arguments must be a JSON object")
    return value


async def _run(args: argparse.Namespace) -> dict[str, Any]:
    profile_home = Path(args.profile_home).expanduser().resolve(strict=True)
    os.environ["HERMES_HOME"] = str(profile_home)

    from mcp import ClientSession
    from mcp.client.streamable_http import streamable_http_client
    from tools.evaos_mcp_lease import (
        EvaosLeaseHttpAuth,
        EvaosLeaseManager,
        EvaosLeaseSource,
    )
    from tools.mcp_tool import mcp_field, sdk_httpx

    config = _managed_server(
        Path(args.managed_config).expanduser().resolve(strict=True),
        args.server,
    )
    source = EvaosLeaseSource(
        profile_key=str(profile_home),
        app_slug=config["app_slug"],
        external_user_id=config.get("external_user_id"),
        account_id=config.get("account_id"),
        customer_id=config.get("customer_id"),
        agent_id=config.get("agent_id"),
    )
    manager = EvaosLeaseManager(source=source)
    auth = EvaosLeaseHttpAuth(manager)
    lease = await manager.get_lease()
    httpx = sdk_httpx()
    if httpx is None or httpx.__name__ != "httpx2":
        raise RuntimeError("MCP SDK HTTP stack mismatch")

    async with httpx.AsyncClient(
        headers=dict(lease.headers),
        auth=auth,
        follow_redirects=False,
        timeout=httpx.Timeout(30.0, read=300.0),
    ) as client:
        async with streamable_http_client(lease.mcp_url, http_client=client) as streams:
            async with ClientSession(streams[0], streams[1]) as session:
                initialized = await session.initialize()
                listed = await session.list_tools()
                tool_names = {tool.name for tool in listed.tools}
                if args.read_tool not in tool_names:
                    raise RuntimeError("selected read tool is absent")
                result = await session.call_tool(
                    args.read_tool,
                    _read_args(Path(args.read_args_json_file)),
                )

    serialized = json.dumps(
        result.model_dump(mode="json", by_alias=True),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return {
        "status": "pass" if not mcp_field(result, "is_error", "isError", False) else "fail",
        "sdk_http_stack": httpx.__name__,
        "initialized": initialized is not None,
        "tool_count": len(tool_names),
        "selected_read_tool_present": True,
        "result_block_count": len(result.content),
        "result_sha256": hashlib.sha256(serialized).hexdigest(),
    }


def main() -> int:
    try:
        receipt = asyncio.run(_run(_parser().parse_args()))
    except Exception as exc:
        print(json.dumps({"status": "error", "error_type": type(exc).__name__}))
        return 1
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt["status"] == "pass" else 2


if __name__ == "__main__":
    raise SystemExit(main())
