"""Background MCP config pickup for the headless serve process."""

import logging
import threading

from hermes_constants import hermes_home_key

logger = logging.getLogger(__name__)
RECONCILE_INTERVAL_S = 60.0  # Gateway housekeeping's default; no shared cadence constant.


class ServeMCPReconciler:
    def __init__(self, server):
        self.server = server
        self.launch_home = hermes_home_key(server._hermes_home)
        self.revisions = {}
        self.pending = set()

    def _homes(self):
        from hermes_cli import mcp_startup

        homes = {self.launch_home}
        with mcp_startup._mcp_discovery_lock:
            homes.update(mcp_startup._mcp_discovery_started)
        with self.server._sessions_lock:
            sessions = list(self.server._sessions.values())
        for sess in sessions:
            with self.server._session_profile_runtime_scope(sess, hydrate_secrets=False):
                if not self.server._session_uses_compute_host(sess):
                    homes.add(hermes_home_key(sess.get("profile_home") or self.launch_home))
        return sorted(homes)

    def pass_once(self):
        server = self.server
        if not server._mcp_reload_lock.acquire(blocking=False):
            return
        try:
            from tools.mcp_oauth import suppress_interactive_oauth
            from tools.mcp_tool_discovery import get_mcp_status, reconcile_mcp_servers_with_config

            for home in self._homes():
                try:
                    scope_home = None if home == self.launch_home else home
                    with server._session_profile_runtime_scope({"profile_home": scope_home}), suppress_interactive_oauth():
                        rev = server._compute_mcp_rev()
                        if home not in self.revisions:
                            self.revisions[home] = rev
                            continue  # Startup discovery owns the first pass per home.
                        missing = any(row["status"] in {"configured", "failed"} for row in get_mcp_status())
                        if rev == self.revisions[home] and home not in self.pending and not missing:
                            continue
                        result = reconcile_mcp_servers_with_config(wait_for_discovery_lock=False)
                        self.revisions[home] = rev
                        if result.get("pending"):
                            self.pending.add(home)
                        else:
                            self.pending.discard(home)
                        if result["added"]:
                            server._refresh_live_sessions(home, preserve_prefix=True)
                        if result["removed"] or result["added"]:
                            # Scope is bound but the home and server definitions are never logged.
                            logger.info("MCP servers reconciled with config (serve): removed=%s added=%s",
                                        result["removed"], result["added"])
                except Exception as exc:
                    # Keep the revision unaccepted on failure; log only the error type (messages can carry credentials).
                    self.pending.add(home)
                    logger.warning("Serve MCP config reconcile failed (%s); retrying next interval", type(exc).__name__)
        finally:
            server._mcp_reload_lock.release()


def start_serve_mcp_reconcile():
    """Return a stop event; discovery never runs on the caller's event loop or build thread."""
    from agent.memory_provider import spawn_context_thread
    from tui_gateway import server

    stop = threading.Event()
    reconciler = ServeMCPReconciler(server)

    def loop():
        while not stop.is_set():
            reconciler.pass_once()
            if stop.wait(RECONCILE_INTERVAL_S):
                break

    spawn_context_thread(loop, name="serve-mcp-reconcile").start()
    return stop
