# evaOS Agent 2026.9.5-es.1 — candidate

This paired update brings the Mac app and managed Hermes runtime onto the same
reviewed upstream snapshot, while keeping existing accounts, profile homes,
conversation stores, encrypted enrollment and the current update stream.
Implementation and release verification are still in progress; this is not a
published-release receipt.

## Highlights

- Catches up to pinned upstream main `f159e581c7afd22a5c94652c569e3859f1b994d2`,
  including its module cleanup and Astra catalog/routing support. The pin does
  not follow a moving branch. [Release scope](https://github.com/electricsheephq/evaOS-hermes-desktop-app-adapter/issues/252)
- Extends the existing Desktop UI protocol to level 3, with action-aware Preview
  tools and newer UI responders. Older clients remain limited to actions they
  can answer. [Compatibility gate](https://github.com/electricsheephq/evaOS-hermes-desktop-app-adapter/issues/254)

## Changes

- Uses `desktop_preview` actions for open/read/close and `gui_tour` for tours;
  retained aliases use the same protocol and session-owner checks.
- Ports managed authentication, assigned routing, MCP leases, profile isolation,
  media and update behavior into upstream's current modules.
- Keeps the existing installer and persistent locations. Synthetic predecessor
  read/append checks are required before any in-place internal update.

## Fixes

- Rejects unsupported GUI actions before emission or waiting, including after
  attachment changes, so a newer runtime cannot leave an older Mac waiting for
  a responder it does not have.
- Preserves existing managed configuration on ordinary package updates instead
  of deleting prior values during upstream default normalization.

## Known Boundaries

- Release, internal continuity and actual updater acceptance are pending.
  Customer VM rollout and employee/fleet acceptance are separate gates.
- Astra fixtures verify catalog/routing, not provider entitlement or a live
  model response. Preview remains on the Mac; VM-local port forwarding and VM GUI
  are not added.

## Release Verification

- Source and artifacts: pending exact merged source and immutable runtime/Mac assets.
- Checks and installed proof: tracked in [#255](https://github.com/electricsheephq/evaOS-hermes-desktop-app-adapter/issues/255).
- Rollback: current Mac `v2026.8.27-es.1` and the verified deployed r30.7 package,
  with stores retained in place.
- Architecture and evidence: [ADR](../../docs/architecture/r31-paired-pinned-main.md),
  [managed-delta ledger](../../docs/r31-managed-delta.md) and
  [release packet](../../docs/releases/r31-paired-release.md).

# evaOS Agent 2026.8.27-es.1

- Aligns the Desktop UI with the exact Hermes r30 upstream base, including Preview read/drive, Bot Mode, tours, MCP setup, and related renderer behavior.
- Declares Desktop UI protocol 2 on session create, resume, and activate so matched runtimes expose only the UI tools this client can answer.
- Preserves managed Electric Sheep authentication, assigned-agent routing, callback ownership, delegated access, relay, updater, and distribution controls.
- Keeps managed REST, media, downloads, and WebSocket responses on the enrolled assignment while preventing background sessions from reading or driving the visible Desktop surface.
- Routes bundled Bot Mode profile requests, connection inventory, and MCP setup actions only through the enrolled managed runtime, including reconnects, while keeping background reactions and capability announcements out of the foreground session.
- Keeps active Preview routes on the opaque enrolled runtime, never borrows saved workstation SSH credentials, and routes approvals plus background process controls through the session that owns them.
- Restores fail-closed local filesystem, Git, terminal, and secure-storage boundaries for managed installations, including account-switch cleanup for cached transcript and in-flight turn data.
- Clears pull-request recovery, session-owner, unread-session, and sidebar-filter metadata with the rest of the account-scoped renderer state during managed sign-out or assignment changes.
- Clears remembered connection profiles on managed account reset, routes session-tile transcription through the tile's exact owner, and keeps legacy cron and messaging sidebar slices complete across profiles without weakening managed assignment scope.
- Preserves ES17's native Safe Storage read ordering and reports only redacted failure categories; genuinely unreadable ciphertext remains preserved and fail-closed. Existing-login upgrade persistence remains a required release gate.
- Uses exact certificate fingerprints through the supported macOS signing hook, avoiding ambiguous display-name selection without patching installed dependencies.
- Keeps managed SSH updates serialized at the configured mutex path without creating quote-prefixed paths in the checkout.
- Publication remains gated on signed/notarized artifact verification and installed upgrade, restart and Preview acceptance; these notes alone are not release proof.

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
