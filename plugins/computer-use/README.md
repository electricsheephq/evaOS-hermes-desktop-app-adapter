# computer-use — the Mac bridge

Lets every agent of a profile (Desktop chat, Telegram, cron — several at once) operate the user's own Mac
through the CUA installed on it. The server never does computer use itself.

```
evaOS Agent (Mac)                    profile gateway (this plugin)             Hermes processes of the profile
private cua-driver daemon  <-- WS /api/plugins/computer-use/bridge -->  dashboard hub  <-- bridge.sock -->  mcp_stdio_shim.py (my-mac)
one `cua-driver mcp` child per conn-id                                   ($HERMES_HOME/computer-use/)          one shim per process
```

- `dashboard/plugin_api.py` — the `/bridge` WebSocket (authorized like kanban's `/events`) and the Unix socket
  `$HERMES_HOME/computer-use/bridge.sock` (0600, in a 0700 dir). The newest Mac connection wins. The Mac's
  `hello` tool list is cached in `computer-use/tools.json`.
- `mcp_stdio_shim.py` — the stdio MCP server Hermes spawns. Online: JSON-RPC passes through message for
  message. Offline: it answers `initialize` / `tools/list` from `tools.json` (else `default_tools.json`, cua-driver
  0.30.2) and `tools/call` fails with: `Your Mac isn't connected. Ask the user to open evaOS Agent and turn on
  Computer Use (left sidebar).` When the Mac comes back it re-initializes and sends `notifications/tools/list_changed`.

Frames (JSON text): Mac→gw `{"t":"hello","v":1,"cua_version","permission_mode":"unrestricted","tools":[…]}`,
gw→Mac `{"t":"open","c":id}`, both ways `{"t":"msg","c":id,"m":<JSON-RPC>}` and `{"t":"close","c":id}`.
Shim↔hub lines: `{"t":"msg","m":…}` both ways, hub→shim `{"t":"online"}` / `{"t":"offline"}`.

## Profile configuration

The dashboard plugin ships bundled, so its API mounts unless `plugins.disabled` lists `computer-use`
(installed as a user plugin instead, add it to `plugins.enabled`). Then:

```yaml
mcp_servers:
  my-mac:
    command: <runtime python>
    args: [<plugin dir>/mcp_stdio_shim.py, --socket, <HERMES_HOME>/computer-use/bridge.sock]
```

Keep the stock `computer_use` toolset off: the server never drives its own screen. The socket path must stay
under the AF_UNIX limit (104 bytes on macOS, 108 on Linux).

Hermes's own approval mode still applies to MCP calls. With this fork's default `approvals.mode: smart`
every `mcp__my-mac__*` call is sent to Hermes's approval (read-only tools included: with the `mcp` 2.0 SDK the
`readOnlyHint` annotation is not recognised); with `approvals.mode: off` none is. How an unattended run (cron)
answers such a prompt is not verified here.

## Agent guidance (for PCS to ship)

When `mcp__my-mac__*` tools are listed you can operate the user's Mac in the background (they run on the
user's own computer, never this server). If the user asks for Mac control and they fail with "not
connected", tell them: open evaOS Agent → Computer Use → Enable.
