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
- Managed backend creation, REST calls, media streams, and saved-file downloads stay on the enrollment runtime; renderer replies return through the event's owning connection/profile rather than the ambient gateway.
- Background sessions receive empty or denied read/drive responses without inspecting the foreground terminal, Preview pane, or native window.
- Managed callback ownership, pending renderer-isolation flush, account-scoped transcript/in-flight cache cleanup, and managed About identity are retained across the upstream reconstruction.
- Managed account reset also clears persisted session-owner routes, unread watermarks/markers, sidebar project/profile filters, and bundled Bot Mode state so a later account cannot hydrate the prior account's session or room metadata.
- The renderer connection inventory and union Bot Mode roster each publish only one opaque assigned-runtime source in managed builds and never read or probe workstation connection-registry entries.
- MCP setup catalog/config writes, OAuth lifecycle calls, reloads, and responses resolve through the requesting session's owning connection/profile; a background Bot tile cannot mutate or answer the foreground gateway.
- Managed active-route storage accepts only the opaque enrolled-runtime identity and Preview reach never borrows saved workstation SSH credentials; approval replay and background process list/kill likewise resolve through the requesting session owner, with dead-session latches scoped to that owner.
- Extracted filesystem, Git, terminal, project-directory, and connection-setting IPC keeps the prior managed fail-closed boundary.
- Managed enrollment credentials require OS-backed secure storage; Electron's Linux `basic_text` backend is not treated as secure.
- The canonical Desktop check once again runs the managed contract suite, and the imported build keeps its required `electron-updater` and root `agent-browser` packages.
- Primary managed gateway recovery forces a fresh connection when a request discovers a closed socket.
- Managed SSH update locking now passes the configured mutex path as one shell argument and expands `~` inside the remote Python helper. This prevents quote-prefixed test or repository paths while preserving serialization.
- An upstream SSH redaction test now uses reserved documentation addresses and a synthetic credential string rather than realistic incident-shaped sample data.
- Blueprint deep-link values escape both quotes and backslashes before becoming a reviewable composer command; inline sandbox messages are accepted only from the exact opaque-origin frame; gateway errors use a fixed log format.

## Intentional supersessions

- The upstream generic `hermes-media://remote` resolver replaces the legacy renderer-managed media-grant route; managed endpoint authorization remains in the Electron boundary.
- The embedded upstream experience is hosted under Skills rather than the retired Hub surface.
- Subscription UI follows the upstream ChatGPT/Codex naming while managed provider and billing restrictions remain authoritative.
- The obsolete monolithic gateway-event module was not replayed; its managed behavior lives in the new split handlers.

## Validation recorded for this candidate

- At the initial reconstruction head, Renderer/UI Vitest passed 631 files and 6,186 tests; Electron Vitest passed 136 files and 1,944 tests, with the documented platform skips.
- On the parity-correction delta, 149 managed Node contracts, 86 focused Electron boundary tests, three Desktop GUI-session isolation tests, four deep-link route tests, and all nine root JS-package tests passed locally.
- Remote lifecycle contract: 91 tests passed.
- TypeScript checks passed for renderer, Electron, end-to-end, and root JS configurations.
- The production Desktop renderer/Electron bundle and native-dependency staging completed successfully under Homebrew Node 26.
- ESLint completed with zero errors; inherited warnings remain non-blocking.

GitHub Actions, CodeQL dispositions, and exact-head semantic review remain required before the branch is frozen for the local installed canary.

## Rollout and rollback boundary

The approved release gate is now the Desktop `2026.8.27-es.1` ARM64 update through the existing GitHub `latest` stream. Current r30 already emits the Preview events: runtime PR #244 remains unmerged and runtime deployment is not a prerequisite. Missing protocol metadata remains legacy-safe on the guarded runtime and older runtimes ignore the new field.

Before merging Desktop PR #245, prove existing encrypted enrollment survives the upgrade and cold restart, and complete the assigned public-site Preview round trip. Fresh sign-in cannot substitute for upgrade persistence. Preserve and verify ES17 outside `/Applications`; restore it immediately on a failed installed attempt. Issue #242 holds the current bounded install budget and exact-head evidence.

The current credential-read diagnostic emits only fixed failure categories, once per category per process. It never logs the exception, stack, ciphertext, plaintext or identity and does not change fail-closed behavior. The previous installed failure remains unresolved until the real preserved-enrollment path passes.

The diagnostic install returned `decrypt-failed`, while restored ES17 read the same preserved enrollment. The candidate-only JavaScript readiness gate is removed: macOS uses ES17's eager native read ordering, and Electron remains responsible for deciding availability. This does not select an alternate key, export credentials, or change encryption. The installed upgrade test must still prove the compatibility correction.

macOS builds use the supported custom-sign hook in `scripts/sign-mac.mjs`. Set `CSC_NAME` to the exact certificate fingerprint resolved by the existing release credential profile; display names and mismatches fail closed. The hook passes the builder's existing nested-code options to its signer without replacing the hash with a display name. No dependency patch is required.

After exact-head source and installed-product gates, merge the Desktop PR, build signed/notarized ZIP and DMG assets plus blockmaps and `latest-mac.yml`, and verify the final bytes with the repository release verifier. Keep ES17 public latest until the final artifact passes locally; then publish and verify one real ES17 in-app update. Failed public acceptance restores ES17 locally and the previous latest pointer, and marks the failed release prerelease so the latest guard cannot reselect it. This prevents new offers, not automatic rollback of already updated devices. Leave #242 open for employee acceptance.

## Non-goals

- No Hermes r30 runtime deployment or VM mutation.
- No dashboard, ws-proxy, Supabase, Browserbase, Mac Access, or authentication-contract change.
- No Linux GUI, VNC/noVNC, or VM-local loopback proxy. The latter is tracked separately in [#243](https://github.com/electricsheephq/evaOS-hermes-desktop-app-adapter/issues/243).
- No managed profile-archive import/export claim. The exact-upstream flow assumes the app and backend share one filesystem; remote managed transfer needs a separate authenticated upload/download contract.
- No move to upstream v2026.8.31 or later.
- No fleet/runtime rollout or employee contact; signed Desktop distribution and existing-stream publication are gated as above.
