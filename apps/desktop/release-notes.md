# evaOS Agent 2026.8.27-es.1

- Aligns the Desktop UI with the exact Hermes r30 upstream base, including Preview read/drive, Bot Mode, tours, MCP setup, and related renderer behavior.
- Declares Desktop UI protocol 2 on session create, resume, and activate so matched runtimes expose only the UI tools this client can answer.
- Preserves managed Electric Sheep authentication, assigned-agent routing, callback ownership, delegated access, relay, updater, and distribution controls.
- Keeps managed REST, media, downloads, and WebSocket responses on the enrolled assignment while preventing background sessions from reading or driving the visible Desktop surface.
- Routes bundled Bot Mode profile requests only through the enrolled managed runtime, including reconnects, while keeping background reactions and capability announcements out of the foreground session.
- Restores fail-closed local filesystem, Git, terminal, and secure-storage boundaries for managed installations, including account-switch cleanup for cached transcript and in-flight turn data.
- Clears pull-request recovery metadata with the rest of the account-scoped renderer state during managed sign-out or assignment changes.
- Preserves an existing encrypted managed enrollment when secure storage cannot decrypt it at startup, returning a retryable local error instead of silently replacing it with signed-out state.
- Keeps managed SSH updates serialized at the configured mutex path without creating quote-prefixed paths in the checkout.
- This is an unpublished developer candidate; it is not a signed or notarized release.

# evaOS Agent 2026.7.20-es.17

- Repairs LaunchServices callback ownership for the canonical `/Applications/evaOS Agent.app` when the owner is missing, has vanished, or is a stale same-bundle app.
- Fails closed for unrelated or indeterminate owners while preserving existing enrollment and presenting safe recovery guidance.

# evaOS Agent 2026.7.20-es.16

- Adds one-hour delegated support sessions for authorized Electric Sheep employees without impersonating customer users.
- Binds each support session to one server-authorized client account, VM, and agent while retaining the employee as the audited actor.
- Shows a persistent acting-for-customer banner and restores the employee context after end, revocation, or absolute expiry.
- Keeps delegated state separate from ordinary enrollment and never places runtime credentials in the renderer or deep link.

# evaOS Agent 2026.7.20-es.15

- Restores managed `/reload-skills` and `/restart` commands while keeping gateway restart scoped to the currently assigned profile.
- Routes the Messaging restart control through the same current-profile action and reports its target and result.
- Retains `/reload-mcp`, cold-boot profile adoption, managed Artifacts and Archived Chats, and friendly assigned-agent labels.

# evaOS Agent 2026.7.20-es.14

- Shows the authorized managed agent name in Profiles while keeping the canonical profile ID for routing, storage, and mutations.
- Retains the ES13 fixes for managed Artifacts, Archived Chats, cold-boot sessions, MCP reload, and signed profile scope.

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
