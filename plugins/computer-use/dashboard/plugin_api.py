"""Computer Use bridge — the user's Mac, reached from this profile's agents.

The evaOS Agent app on the user's Mac dials ``/api/plugins/computer-use/bridge`` (a WebSocket,
authorized exactly like kanban's ``/events``) and serves its local cua-driver over it. Every Hermes
process of this profile (gateway, Desktop agent, cron) spawns ``mcp_stdio_shim.py`` from
``mcp_servers.my-mac``; each shim connects to ``$HERMES_HOME/computer-use/bridge.sock`` and gets its
own conn-id, so the Mac runs one cua-driver MCP child per agent connection.

Frames (JSON text): Mac→gw ``hello`` (tools manifest), gw→Mac ``open``, both ways ``msg`` / ``close``.
Shim↔gw lines: ``msg`` both ways, gw→shim ``online`` / ``offline``. Nothing here approves or restricts
anything: the newest Mac connection wins (routing), and the 0600 socket keeps profiles apart.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status as http_status

log = logging.getLogger(__name__)

router = APIRouter()

REOPEN_DELAY_SECONDS = 2.0
# Largest JSON-RPC message carried either way (base64 screenshots are MB-sized); the shim and the Mac
# answer a bigger one with an error for that call, so the socket reader only needs envelope headroom.
MAX_MESSAGE_BYTES = 64 * 1024 * 1024
LINE_LIMIT = MAX_MESSAGE_BYTES + 64 * 1024


def _ws_upgrade_authorized(ws: "WebSocket") -> bool:
    """The dashboard's canonical WS gate (``?token=`` / ``?ticket=`` / ``?internal=``), as kanban does;
    accepts when the dashboard isn't importable (bare-FastAPI test harness)."""
    try:
        from hermes_cli import web_server_chat as _ws
    except Exception:
        return True
    return bool(_ws._ws_auth_ok(ws))


def _line(frame: Dict[str, Any]) -> bytes:
    return (json.dumps(frame, separators=(",", ":")) + "\n").encode()


class Hub:
    """One per profile home: the current Mac WebSocket plus the local shims."""

    def __init__(self, home: Path) -> None:
        self.dir = home / "computer-use"
        self.sock_path = self.dir / "bridge.sock"
        self.mac: Optional[WebSocket] = None
        self.ready = False  # the current Mac has sent hello
        self.shims: Dict[str, asyncio.StreamWriter] = {}
        self._server: Optional[asyncio.AbstractServer] = None
        self._send_lock = asyncio.Lock()
        self._tasks: set = set()

    async def ensure_socket(self) -> None:
        if self._server is not None:
            return
        self.dir.mkdir(parents=True, exist_ok=True)
        os.chmod(self.dir, 0o700)
        if self.sock_path.exists() or self.sock_path.is_symlink():
            self.sock_path.unlink()  # stale socket from an earlier dashboard process
        self._server = await asyncio.start_unix_server(self._serve_shim, path=str(self.sock_path), limit=LINE_LIMIT)
        os.chmod(self.sock_path, 0o600)

    def save_tools(self, hello: Dict[str, Any]) -> None:
        record = {"cua_version": hello.get("cua_version"), "tools": hello.get("tools") or [], "saved_at": time.time()}
        tmp = self.dir / "tools.json.tmp"
        tmp.write_text(json.dumps(record), encoding="utf-8")
        os.replace(tmp, self.dir / "tools.json")

    async def _to_shim(self, cid: str, frame: Dict[str, Any]) -> None:
        writer = self.shims.get(cid)
        if writer is None:
            return
        try:
            writer.write(_line(frame))
            await writer.drain()
        except (ConnectionError, OSError):
            self.shims.pop(cid, None)

    async def _to_mac(self, frame: Dict[str, Any], mac: Optional[WebSocket] = None) -> bool:
        mac = mac or self.mac
        if mac is None:
            return False
        try:
            async with self._send_lock:
                await mac.send_text(json.dumps(frame, separators=(",", ":")))
            return True
        except Exception:
            return False

    async def _open(self, cid: str, mac: Optional[WebSocket]) -> None:
        """Ask ``mac`` for a CUA child for ``cid``, then tell its shim it is online. Bound to that Mac:
        once a newer Mac has taken over (during any await), this work is dropped."""
        if mac is None or mac is not self.mac or not self.ready:
            return
        if await self._to_mac({"t": "open", "c": cid}, mac) and mac is self.mac:
            await self._to_shim(cid, {"t": "online"})

    async def attach_mac(self, ws: WebSocket) -> None:
        old, self.mac, self.ready = self.mac, ws, False
        if old is not None:
            log.info("computer-use: a newer Mac connection replaced the previous one")
            for cid in list(self.shims):
                await self._to_shim(cid, {"t": "offline"})
            try:
                await old.close(code=4000, reason="replaced by a newer connection")
            except Exception:
                pass

    async def on_hello(self, ws: WebSocket, hello: Dict[str, Any]) -> None:
        if ws is not self.mac:
            return
        self.save_tools(hello)
        self.ready = True
        log.info("computer-use: Mac connected (cua-driver %s, %s, %d tools)", hello.get("cua_version"),
                 hello.get("permission_mode"), len(hello.get("tools") or []))
        for cid in list(self.shims):
            if ws is not self.mac:
                return
            await self._open(cid, ws)

    async def on_mac_frame(self, ws: WebSocket, frame: Dict[str, Any]) -> None:
        kind, cid = frame.get("t"), str(frame.get("c") or "")
        if kind == "hello":
            await self.on_hello(ws, frame)
        elif ws is not self.mac:
            return
        elif kind == "msg" and isinstance(frame.get("m"), dict):
            await self._to_shim(cid, {"t": "msg", "m": frame["m"]})
        elif kind == "close" and cid in self.shims:
            # The Mac's child for this conn ended: the shim goes offline and gets a fresh child shortly.
            await self._to_shim(cid, {"t": "offline"})
            task = asyncio.create_task(self._reopen_later(ws, cid))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    async def _reopen_later(self, ws: WebSocket, cid: str) -> None:
        await asyncio.sleep(REOPEN_DELAY_SECONDS)
        if cid in self.shims:
            await self._open(cid, ws)

    async def detach_mac(self, ws: WebSocket) -> None:
        if ws is not self.mac:
            return
        self.mac, self.ready = None, False
        log.info("computer-use: Mac disconnected")
        for cid in list(self.shims):
            await self._to_shim(cid, {"t": "offline"})

    async def _serve_shim(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        cid = uuid.uuid4().hex[:12]
        self.shims[cid] = writer
        await self._open(cid, self.mac)
        try:
            while True:
                try:
                    line = await reader.readline()
                except ValueError:  # over LINE_LIMIT: that frame is dropped, the connection stays
                    log.warning("computer-use: dropped a shim frame over %d bytes", LINE_LIMIT)
                    continue
                if not line:
                    break
                try:
                    frame = json.loads(line)
                except ValueError:
                    continue
                if frame.get("t") == "msg" and isinstance(frame.get("m"), dict):
                    await self._to_mac({"t": "msg", "c": cid, "m": frame["m"]})
        except (ConnectionError, OSError):
            pass
        finally:
            self.shims.pop(cid, None)
            if self.ready:
                await self._to_mac({"t": "close", "c": cid})
            writer.close()


_hubs: Dict[str, Hub] = {}


def hub_for(home: Path) -> Hub:
    key = str(home)
    if key not in _hubs:
        _hubs[key] = Hub(home)
    return _hubs[key]


def _current_home() -> Path:
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home())


@router.websocket("/bridge")
async def mac_bridge(ws: WebSocket):
    if not _ws_upgrade_authorized(ws):
        await ws.close(code=http_status.WS_1008_POLICY_VIOLATION)
        return
    await ws.accept()
    hub = hub_for(_current_home())
    await hub.ensure_socket()
    await hub.attach_mac(ws)
    try:
        while True:
            raw = await ws.receive_text()
            try:
                frame = json.loads(raw)
            except ValueError:
                continue
            if isinstance(frame, dict):
                await hub.on_mac_frame(ws, frame)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except Exception as exc:  # never crash the dashboard worker
        log.warning("computer-use bridge error: %s", exc)
    finally:
        await hub.detach_mac(ws)
