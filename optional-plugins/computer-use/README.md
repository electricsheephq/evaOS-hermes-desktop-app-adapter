# computer-use — the Mac bridge

Lets every agent of a profile (Desktop chat, Telegram, cron — several at once) operate the user's own Mac
through the CUA installed on it. The server never does computer use itself.

```
evaOS Agent (Mac)                    profile gateway (this plugin)             Hermes processes of the profile
private cua-driver daemon  <-- WS /api/plugins/computer-use/bridge -->  dashboard hub  <-- bridge.sock -->  mcp_stdio_shim.py (my-mac)
one `cua-driver mcp` child per conn-id                                   ($HERMES_HOME/computer-use/)          one shim per process
```

- `dashboard/plugin_api.py` — the `/bridge` WebSocket (authorized like kanban's `/events`) and the Unix socket
  `$HERMES_HOME/computer-use/bridge.sock` (0600, in a 0700 dir). The newest Mac that says `hello` wins. The Mac's
  `hello` tool list is cached in `computer-use/tools.json`. A Mac silent for 60 s is dropped. `GET /available`
  answers `{"ok": true, "plugin": "computer-use"}`: the Mac app shows Computer Use only for an agent that answers it.
- `mcp_stdio_shim.py` — the stdio MCP server Hermes spawns. Online: JSON-RPC passes through message for
  message. Offline: it answers `initialize` / `tools/list` from `tools.json` (else `default_tools.json`, cua-driver
  0.30.2) and `tools/call` fails with: `Your Mac isn't connected. Ask the user to open evaOS Agent → Computer Use →
  Enable.` A call in flight when the link drops fails with: `The connection to the user's Mac dropped during this
  action; it may or may not have run. Check the Mac's state before retrying.` When the Mac comes back it
  re-initializes and sends `notifications/tools/list_changed`.

Frames (JSON text): Mac→gw `{"t":"hello","v":1,"cua_version","permission_mode":"unrestricted","tools":[…]}`,
gw→Mac `{"t":"open","c":id}`, both ways `{"t":"msg","c":id,"m":<JSON-RPC>}` and `{"t":"close","c":id}`,
Mac→gw `{"t":"ping"}` every 20 s answered `{"t":"pong"}`. Each side ignores frame types it does not know.
Shim↔hub lines: `{"t":"msg","m":…}` both ways, hub→shim `{"t":"online"}` / `{"t":"offline"}`.

## Install (per profile, as a user plugin)

This plugin is optional: it is not bundled, so nothing mounts on a profile until it is installed there.

1. Copy this folder to `$HERMES_HOME/plugins/computer-use`.
2. Add `computer-use` to the profile's `plugins.enabled`.
3. Add the `my-mac` MCP server (no `trust:` key). Replace `<HERMES_HOME>` with the profile's real path: Hermes
   does not expand `$HERMES_HOME` in `mcp_servers` args.

   ```yaml
   mcp_servers:
     my-mac:
       command: /usr/bin/python3  # the shim is stdlib-only; a release venv python also works
       args: [<HERMES_HOME>/plugins/computer-use/mcp_stdio_shim.py, --socket, <HERMES_HOME>/computer-use/bridge.sock]
   ```

4. Restart the profile so the API mounts.

Keep the stock `computer_use` toolset off: the server never drives its own screen. The socket path must stay under
the AF_UNIX limit (104 bytes on macOS, 108 on Linux).

Hermes's own approval mode still applies to MCP calls. With this fork's default `approvals.mode: smart`
every `mcp__my_mac__*` call is sent to Hermes's approval (read-only tools included: with the `mcp` 2.0 SDK the
`readOnlyHint` annotation is not recognised); with `approvals.mode: off` none is. How an unattended run (cron)
answers such a prompt is not verified here.

## Agent guidance (for PCS to ship)

When `my-mac` tools (`mcp__my_mac__*`, listed under `my-mac` in tool_search) are available, you can operate the
user's own Mac in the background with them, from any conversation. If the user asks you to use their Mac and a
call says the Mac isn't connected, tell them: open evaOS Agent → Computer Use → Enable.
