# Desktop v2026.8.27 managed-delta ledger

This ledger records how the evaOS Agent Desktop candidate was reconstructed and which Electric Sheep behavior was retained. It is a product-delta map, not a substitute for the exact Git diff.

## Identity

- Candidate version: `2026.8.27-es.1`
- Electric Sheep source: `main@d45efea463804c189d4f90ddbd2f45e301c7c035`
- Upstream Desktop base: `5fc308a70719a83cccdbba4c0e39c23f5a8239d5` (`v2026.8.27`)
- Common ancestor used to identify the prior managed delta: `4075c8f1c8466fa13086678f6c5aef253a6a8b84`
- Exact upstream snapshot commit on this branch: `4d5fcaaf9bc0f3725905e3b7153eb2cb7c114bdb`
- Tracking bug: [#242](https://github.com/electricsheephq/evaOS-hermes-desktop-app-adapter/issues/242)
- Existing Desktop-parity dependency: [#39](https://github.com/electricsheephq/evaOS-hermes-desktop-app-adapter/issues/39)

## Reconstruction method

1. Replace the Desktop surface with the exact upstream `v2026.8.27` tree used by Hermes r30.
2. Restore the compatible repository-level and shared inputs needed to build that tree.
3. Replay the net Electric Sheep product delta from the prior managed Desktop line, resolving upstream structural changes at the current owning modules.
4. Add only the narrow client-protocol marker and corrections proven necessary by the managed contract tests.

This is not a linear commit replay, so a mechanical `git range-diff` would misstate the result. The exact branch diff remains authoritative; the sections below map product behavior across the reconstructed tree.

## Upstream v2026.8.27 surface imported

- Preview open, read, drive, annotate, and close responders and their Browser/Preview pane UI.
- Bot Mode, guided tours, MCP setup, and related renderer behavior.
- The split API and gateway-event modules introduced after the prior Desktop base.
- The generic secure remote-media proxy and the upstream Skills-hosted embedded experience.

## Electric Sheep behavior retained

- evaOS Agent branding, bundle identity, native icons, and window titles.
- Managed browser authentication, enrollment, PKCE/deep-link callback ownership, and safe callback recovery.
- Server-assigned agent routing, active-profile scoping, and delegated-access presentation.
- Managed WebSocket relay, endpoint-bound plugin tickets, and profile-aware reconnect behavior.
- Managed updater selection, signing and distribution configuration, release verification, and update scripts.
- Managed UI restrictions, billing/credit suppression, model and provider policy, and sanitized boot-failure recovery.
- Existing managed contract, Electron, renderer, and end-to-end test gates.

## Candidate-only compatibility corrections

- `desktop_ui_protocol: 2` is added only to Desktop `session.create`, `session.resume`, and `session.activate` requests. It is capability metadata, not authorization.
- Primary managed gateway recovery forces a fresh connection when a request discovers a closed socket.
- Managed SSH update locking now passes the configured mutex path as one shell argument and expands `~` inside the remote Python helper. This prevents quote-prefixed test or repository paths while preserving serialization.
- An upstream SSH redaction test now uses reserved documentation addresses and a synthetic credential string rather than realistic incident-shaped sample data.

## Intentional supersessions

- The upstream generic `hermes-media://remote` resolver replaces the legacy renderer-managed media-grant route; managed endpoint authorization remains in the Electron boundary.
- The embedded upstream experience is hosted under Skills rather than the retired Hub surface.
- Subscription UI follows the upstream ChatGPT/Codex naming while managed provider and billing restrictions remain authoritative.
- The obsolete monolithic gateway-event module was not replayed; its managed behavior lives in the new split handlers.

## Validation recorded for this candidate

- Renderer/UI Vitest: 631 files and 6,186 tests passed.
- Electron Vitest: 136 files passed and 2 skipped; 1,944 tests passed and 6 skipped.
- Managed Node contracts: 147 tests passed.
- Remote lifecycle contract: 91 tests passed.
- TypeScript checks passed for renderer, Electron, and shared configurations.
- ESLint completed with zero errors; inherited warnings remain non-blocking.

GitHub Actions and exact-head semantic review remain required before the branch is frozen for the local installed canary.

## Rollout and rollback boundary

The later release owner should merge and deploy the runtime protocol guard before the Desktop candidate, then produce the signed and notarized macOS release through the canonical release path. Missing protocol metadata remains legacy-safe and older runtimes ignore the new field.

This candidate must not be tagged, published, or placed in an updater feed by this PR. Before the authorized local canary, preserve and verify the installed ES17 app outside `/Applications`. Restore ES17 immediately if the candidate fails identity checks or the synthetic Preview round trip.

## Non-goals

- No Hermes r30 runtime deployment or VM mutation.
- No dashboard, ws-proxy, Supabase, Browserbase, Mac Access, or authentication-contract change.
- No Linux GUI, VNC/noVNC, or VM-local loopback proxy. The latter is tracked separately in [#243](https://github.com/electricsheephq/evaOS-hermes-desktop-app-adapter/issues/243).
- No move to upstream v2026.8.31 or later.
- No signed distribution, updater publication, fleet rollout, or Karlen contact.
