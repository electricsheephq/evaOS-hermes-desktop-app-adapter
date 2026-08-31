# evaOS Agent 2026.7.20-es.13

- Scopes managed Artifacts, Archived Chats, and session pickers to the signed active agent profile instead of the aggregate profile selector.
- Shows the authorized assigned-agent display name and the managed Electric Sheep vendor name while keeping canonical account and agent IDs internal.

- Restores the assigned managed profile after every app restart so sessions load and new chats stay on the authorized agent.
- Loads managed MCP configuration before server discovery, avoiding a manual reload on fresh sessions.
- Restores `/reload-mcp` in the desktop command palette with the existing confirmation-preserving backend action.
- Adds short-lived, profile-authoritative authentication for Pipedream's native MCP without placing developer or provider credentials on customer VMs.
- Uses root-configured customer, Hermes agent, and app identity for that token refresh and no longer reads a per-app provider-grant file.
- Runs tools annotated exactly `readOnlyHint: true` directly and routes every write-capable or unannotated MCP call through Hermes' existing approval mode before any connection or RPC.
- Preserves the shared customer gateway, distinct profile homes and LCM databases, per-profile Desktop controls, and the signed Electric Sheep update path.
