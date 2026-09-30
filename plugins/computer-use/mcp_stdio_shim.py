"""stdio MCP server ``my-mac``: this Hermes process's door to the user's Mac.

Hermes spawns it from ``mcp_servers.my-mac``. It connects to the profile's bridge socket (served by the
dashboard's ``computer-use`` plugin) and, while the Mac is online, passes JSON-RPC through message for
message to a cua-driver MCP child on the Mac. While the Mac is offline it answers ``initialize`` and
``tools/list`` itself (from ``tools.json`` beside the socket, else the bundled ``default_tools.json``)
and fails ``tools/call`` with a plain sentence the agent can relay. When the Mac comes (back) online
mid-session it re-initializes the new child with Hermes's original ``initialize`` params and emits
``notifications/tools/list_changed``. Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

OFFLINE_TEXT = "Your Mac isn't connected. Ask the user to open evaOS Agent and turn on Computer Use (left sidebar)."
RETRY_SECONDS = 2.0
REPLAY_ID = "my-mac-reinit"


class Shim:
    def __init__(self, sock_path: str, out=None) -> None:
        self.sock_path = sock_path
        self.out = out or sys.stdout
        self.lock = threading.RLock()
        self.sock: Optional[socket.socket] = None
        self.online = False
        self.init_params: Optional[Dict[str, Any]] = None
        self.pending: Dict[Any, str] = {}  # request id forwarded to the Mac -> method

    # -- cache ------------------------------------------------------------------------------------
    def cached(self) -> Dict[str, Any]:
        for path in (Path(self.sock_path).parent / "tools.json", Path(__file__).with_name("default_tools.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(data.get("tools"), list):
                    return data
            except (OSError, ValueError, AttributeError):
                continue
        return {"cua_version": None, "tools": []}

    # -- output -----------------------------------------------------------------------------------
    def emit(self, message: Dict[str, Any]) -> None:
        with self.lock:
            self.out.write(json.dumps(message, separators=(",", ":")) + "\n")
            self.out.flush()

    def send_up(self, message: Dict[str, Any]) -> bool:
        with self.lock:
            if self.sock is None:
                return False
            try:
                self.sock.sendall((json.dumps({"t": "msg", "m": message}, separators=(",", ":")) + "\n").encode())
                return True
            except OSError:
                return False

    # -- offline answers --------------------------------------------------------------------------
    def answer_offline(self, message: Dict[str, Any]) -> None:
        method, rid = message.get("method"), message.get("id")
        if rid is None:
            return  # a notification: nothing to answer
        params = message.get("params") or {}
        if method == "initialize":
            result: Any = {"protocolVersion": params.get("protocolVersion", "2025-06-18"),
                           "capabilities": {"tools": {"listChanged": True}},
                           "serverInfo": {"name": "cua-driver", "version": self.cached().get("cua_version") or "offline"}}
        elif method == "tools/list":
            result = {"tools": self.cached()["tools"]}
        elif method == "tools/call":
            result = {"content": [{"type": "text", "text": OFFLINE_TEXT}], "isError": True}
        elif method == "ping":
            result = {}
        elif method in ("resources/list", "prompts/list", "resources/templates/list"):
            key = {"resources/list": "resources", "prompts/list": "prompts"}.get(method, "resourceTemplates")
            result = {key: []}
        else:
            self.emit({"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": OFFLINE_TEXT}})
            return
        self.emit({"jsonrpc": "2.0", "id": rid, "result": result})

    # -- Hermes -> Mac ----------------------------------------------------------------------------
    def from_hermes(self, message: Dict[str, Any]) -> None:
        with self.lock:
            if message.get("method") == "initialize":
                self.init_params = message.get("params") or {}
            rid = message.get("id")
            if self.online and "method" in message and rid is not None:
                self.pending[rid] = message["method"]
            if self.online and self.send_up(message):
                return
            self.pending.pop(rid, None)
        self.answer_offline(message)

    # -- dashboard -> shim ------------------------------------------------------------------------
    def go_online(self) -> None:
        with self.lock:
            if self.online:
                return
            self.online = True
            if self.init_params is None:
                return  # Hermes's own initialize will pass straight through
            # Hermes already initialized against us: bring the new child up with the same params.
            self.send_up({"jsonrpc": "2.0", "id": REPLAY_ID, "method": "initialize", "params": self.init_params})
            self.send_up({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.emit({"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})

    def go_offline(self) -> None:
        with self.lock:
            self.online = False
            pending, self.pending = self.pending, {}
        for rid, method in pending.items():
            self.answer_offline({"id": rid, "method": method})

    def from_dashboard(self, frame: Dict[str, Any]) -> None:
        kind = frame.get("t")
        if kind == "online":
            self.go_online()
        elif kind == "offline":
            self.go_offline()
        elif kind == "msg" and isinstance(frame.get("m"), dict):
            message = frame["m"]
            if message.get("id") == REPLAY_ID and "method" not in message:
                return  # the child's answer to our replayed initialize
            with self.lock:
                if "method" not in message:
                    self.pending.pop(message.get("id"), None)
            self.emit(message)

    # -- loops ------------------------------------------------------------------------------------
    def socket_loop(self) -> None:
        while True:
            try:
                conn = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                conn.connect(self.sock_path)
            except OSError:
                time.sleep(RETRY_SECONDS)
                continue
            with self.lock:
                self.sock = conn
            try:
                for raw in conn.makefile("rb"):
                    try:
                        frame = json.loads(raw)
                    except ValueError:
                        continue
                    if isinstance(frame, dict):
                        self.from_dashboard(frame)
            except OSError:
                pass
            with self.lock:
                self.sock = None
            self.go_offline()
            conn.close()
            time.sleep(RETRY_SECONDS)

    def stdin_loop(self, stdin=None) -> None:
        for raw in stdin or sys.stdin:
            try:
                message = json.loads(raw)
            except ValueError:
                continue
            if isinstance(message, dict):
                self.from_hermes(message)


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True)
    args = parser.parse_args(argv)
    shim = Shim(args.socket)
    threading.Thread(target=shim.socket_loop, name="my-mac-socket", daemon=True).start()
    shim.stdin_loop()


if __name__ == "__main__":
    main()
