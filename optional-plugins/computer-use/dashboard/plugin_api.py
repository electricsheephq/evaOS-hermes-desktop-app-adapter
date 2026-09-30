"""Computer Use bridge — the user's Mac, reached from this profile's agents.

The evaOS Agent app on the user's Mac dials ``/api/plugins/computer-use/bridge`` (a WebSocket,
authorized exactly like kanban's ``/events``) and serves its local cua-driver over it. Every Hermes
process of this profile (gateway, Desktop agent, cron) spawns ``mcp_stdio_shim.py`` from
``mcp_servers.my-mac``; each shim connects to ``$HERMES_HOME/computer-use/bridge.sock`` and gets its
own conn-id, so the Mac runs one cua-driver MCP child per agent connection.

Frames (JSON text): Mac→gw ``hello`` (tools manifest), gw→Mac ``open``, both ways ``msg`` / ``close``.
Liveness: the Mac sends ``ping`` (answered ``pong``); a Mac silent for ``RECEIVE_TIMEOUT_SECONDS`` is
dropped, so every shim goes offline at once. Unknown frame types are ignored. Shim↔gw lines: ``msg`` both
ways, gw→shim ``online`` / ``offline``. Nothing here approves or restricts anything: the newest Mac that says
``hello`` wins (routing), and the 0600 socket keeps profiles apart.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status as http_status

log = logging.getLogger(__name__)

router = APIRouter()

# A conn whose Mac child ends is reopened after 2 s, doubling to 60 s; an open that lasted 30 s resets it.
REOPEN_DELAY_SECONDS = 2.0
REOPEN_MAX_SECONDS = 60.0
REOPEN_STABLE_SECONDS = 30.0
# Past this many reopens in a row the delay is REOPEN_MAX_SECONDS anyway; the count stops here (no overflow).
REOPEN_ATTEMPTS_CAP = 16
# The Mac pings every 20 s: this long without any frame means the link is dead (sleep, lost network).
RECEIVE_TIMEOUT_SECONDS = 60.0
# Largest JSON-RPC message carried either way (base64 screenshots are MB-sized); the shim and the Mac
# answer a bigger one with an error for that call, so the socket reader only needs envelope headroom.
MAX_MESSAGE_BYTES = 64 * 1024 * 1024
LINE_LIMIT = MAX_MESSAGE_BYTES + 64 * 1024
# The dashboard's plugin gate is HTTP middleware; a connected bridge re-asks it this often (4000 when disabled).
PLUGIN_CHECK_SECONDS = 30.0
PLUGIN_NAME = "computer-use"


def _ws_upgrade_authorized(ws: "WebSocket") -> bool:
    """The dashboard's canonical WS gate (``?token=`` / ``?ticket=`` / ``?internal=``), as kanban does;
    accepts when the dashboard isn't importable (bare-FastAPI test harness)."""
    try:
        from hermes_cli import web_server_chat as _ws
    except Exception:
        return True
    return bool(_ws._ws_auth_ok(ws))


def _plugin_disabled(profile: Optional[str]) -> bool:
    """The runtime plugin gate's decision (``web_server._plugin_api_runtime_gate``, which does not run for
    WebSockets) for ``profile``'s config: the same enabled/disabled sets, plugin list and trust rule. False when
    the dashboard isn't importable (bare-FastAPI test harness)."""
    try:
        from hermes_cli.plugins_cmd import _get_disabled_set, _get_enabled_set
        from hermes_cli.web_server import _get_dashboard_plugins
        from hermes_cli.web_server_dashboard import _plugin_api_mount_skip_reason
        from hermes_cli.web_server_profiles import _config_profile_scope
    except ImportError:
        return False
    with _config_profile_scope(profile or None):
        enabled, disabled = _get_enabled_set(), _get_disabled_set()
    plugin = next((p for p in _get_dashboard_plugins() if p.get("name") == PLUGIN_NAME), None)
    return _plugin_api_mount_skip_reason(plugin or {"name": PLUGIN_NAME, "source": "user"}, enabled, disabled) is not None


def _clock() -> float:
    return time.monotonic()


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
        self._reopen_attempts: Dict[str, int] = {}
        self._opened_at: Dict[str, float] = {}

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
            self._opened_at[cid] = _clock()
            await self._to_shim(cid, {"t": "online"})

    async def attach_mac(self, ws: WebSocket) -> None:
        """Make ``ws`` the current Mac. Called on its ``hello``, never at the upgrade: an upgrade that never
        says hello must not evict the live Mac (4000 is terminal on the Mac until the user toggles Enable)."""
        if ws is self.mac:
            return
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
        if not isinstance(hello.get("tools"), list):
            return
        if ws is self.mac and self.ready:
            # A repeat hello (the Mac restarted its daemon): every conn gets a fresh child, re-initialized.
            for cid in list(self.shims):
                await self._to_shim(cid, {"t": "offline"})
        await self.attach_mac(ws)
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
            task = asyncio.create_task(self._reopen_later(ws, cid, self._reopen_delay(cid)))
            self._tasks.add(task)
            task.add_done_callback(self._tasks.discard)

    def _reopen_delay(self, cid: str) -> float:
        opened = self._opened_at.pop(cid, None)
        if opened is not None and _clock() - opened >= REOPEN_STABLE_SECONDS:
            self._reopen_attempts[cid] = 0
        attempt = min(self._reopen_attempts.get(cid, 0), REOPEN_ATTEMPTS_CAP)
        self._reopen_attempts[cid] = attempt + 1
        return min(REOPEN_MAX_SECONDS, REOPEN_DELAY_SECONDS * 2 ** attempt)

    async def _reopen_later(self, ws: WebSocket, cid: str, delay: float) -> None:
        await asyncio.sleep(delay)
        if cid in self.shims and cid not in self._opened_at:  # not already reopened by a hello meanwhile
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
            self._reopen_attempts.pop(cid, None)
            self._opened_at.pop(cid, None)
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


def _served_profile(requested: str) -> Optional[str]:
    """The relay's ``?profile=`` as one of the profiles Hermes lists for this process (``list_profiles``; on a
    managed one-profile gateway only its own). Paths and config scopes below use Hermes' own name, never the
    request's. None when it names no profile served here."""
    try:
        from hermes_cli.profiles import list_profiles, normalize_profile_name
        wanted = normalize_profile_name(requested)
        return next((p.name for p in list_profiles(lazy_skill_count=True) if p.name == wanted), None)
    except Exception:
        return None


def _profile_target(requested: str) -> Optional[Tuple[str, Path]]:
    """(profile, home) whose agents this bridge serves: the relay's ``?profile=`` (one process may serve many
    profiles), resolved as the dashboard's per-profile routes do; none named = ("", this process's own home).
    None when the request names no profile served here."""
    if not requested or requested.lower() == "current":
        return "", _current_home()
    profile = _served_profile(requested)
    if profile is None:
        return None
    try:
        from hermes_cli.web_server_profiles import _resolve_profile_dir
        target = _resolve_profile_dir(profile)
    except Exception:
        return None
    current = _current_home()
    return profile, (current if target.resolve() == current.resolve() else target)


async def _close_quietly(ws: WebSocket, code: int, reason: str) -> None:
    try:
        await asyncio.wait_for(ws.close(code=code, reason=reason), 5)
    except Exception:
        pass


@router.get("/available")
async def available() -> Dict[str, Any]:
    """The Mac app shows Computer Use only for a profile that answers this (Hermes answers 404 for an absent or
    unenabled plugin). Behind the dashboard's normal HTTP auth; says nothing else."""
    return {"ok": True, "plugin": "computer-use"}


@router.websocket("/bridge")
async def mac_bridge(ws: WebSocket):
    if not _ws_upgrade_authorized(ws):
        await ws.close(code=http_status.WS_1008_POLICY_VIOLATION)
        return
    target = _profile_target((ws.query_params.get("profile") or "").strip())
    try:
        disabled = target is None or _plugin_disabled(target[0])
    except Exception as exc:
        log.warning("computer-use: could not read the plugin setting: %s", exc)
        disabled = True
    if disabled or target is None:
        await ws.close(code=http_status.WS_1008_POLICY_VIOLATION)
        return
    profile, home = target
    await ws.accept()
    hub = hub_for(home)
    try:
        await hub.ensure_socket()
        last_frame = checked = _clock()
        while True:
            now = _clock()
            if now - checked >= PLUGIN_CHECK_SECONDS:
                checked = now
                try:
                    disabled = _plugin_disabled(profile)
                except Exception as exc:  # can't tell: keep the Mac
                    log.warning("computer-use: could not re-read the plugin setting: %s", exc)
                if disabled:
                    log.info("computer-use: the plugin was disabled; dropping the Mac")
                    await hub.detach_mac(ws)  # every shim offline: calls on the Mac are answered now
                    await _close_quietly(ws, 4000, "computer-use plugin disabled")
                    break
            wait = min(RECEIVE_TIMEOUT_SECONDS - (now - last_frame), PLUGIN_CHECK_SECONDS - (now - checked))
            try:
                raw = await asyncio.wait_for(ws.receive_text(), max(wait, 0.0))
            except asyncio.TimeoutError:
                if _clock() - last_frame < RECEIVE_TIMEOUT_SECONDS:
                    continue  # only the plugin check is due
                log.info("computer-use: no frame from the Mac for %ds; dropping it", RECEIVE_TIMEOUT_SECONDS)
                await _close_quietly(ws, 1001, "no frames")
                break
            last_frame = _clock()
            try:
                frame = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(frame, dict):
                continue
            if frame.get("t") == "ping":
                await hub._to_mac({"t": "pong"}, ws)
            else:
                await hub.on_mac_frame(ws, frame)
    except (WebSocketDisconnect, asyncio.CancelledError):
        pass
    except OSError as exc:
        log.warning("computer-use: bridge socket unavailable: %s", exc)
        await _close_quietly(ws, 1011, "bridge socket unavailable")
    except Exception as exc:  # never crash the dashboard worker
        log.warning("computer-use bridge error: %s", exc)
    finally:
        await hub.detach_mac(ws)
