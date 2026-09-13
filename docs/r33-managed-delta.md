# r33.0 managed-delta ledger

Successor to [r32](r32-managed-delta.md), under [the paired-source ADR](architecture/r31-paired-pinned-main.md) and [the tagged-release cadence](architecture/upstream-sync-cadence.md). This ledger qualifies source only; release, installation, fleet and customer gates remain with the orchestrator.

## Frozen source identities

- Base: `6fdaa684898762fbb43721390eb8d8fd1cbd2fe9` (`origin/main` at cut admission).
- Upstream: `939e45c91d751fadd94dcd1b873ac3cb44846213`, annotated tag `v2026.9.11`, Hermes `0.21.2`.
- Merge base: `2237be355906fbe6065ce1815711eee52b2d646e` (the r32 pin).
- Merge commit: `26fa88b03beadbfbbe7e1139843ea3e8d5f1d747`.
- Initial resolved merge tree: `3d10f477ad60f9dce50a9df09d4348c0765fae49`.
- Planned runtime tag, not created here: `evaos-runtime-es.12-v0.21.2-r33.0`.
- The merge commit has exactly the frozen base and upstream commits as its parents. Merge the PR with a merge commit, never squash or rebase, so the upstream parent survives.
- `pyproject.toml`, the worktree CLI, and the tag report `0.21.2`; `uv.lock` is byte-identical to upstream. Desktop version `2026.9.5-es.1` is deliberately unstamped in this lane.

## Conflict resolution

The live merge produced 30 content-conflicted files and 51 hunks, with zero rename/delete conflicts. Recon expected 29 files: `apps/desktop/src/app/gateway/hooks/use-gateway-boot.ts` auto-merged, while `apps/desktop/src/app/messaging/index.test.tsx` and `apps/desktop/src/store/profile.ts` were extra content-only conflicts. Choices: 1 upstream, 0 ours-only, 50 both-merged. The cut artifact `RESOLUTIONS.md` is the hunk-level record; this table is its file summary.

| File | Hunks | Resolution | Managed invariant where retained |
|---|---:|---|---|
| `apps/desktop/e2e/chat.spec.ts` | 1 | both | managed release test routing |
| `apps/desktop/electron/fs-ipc.ts` | 1 | both | managed local mutation denial |
| `apps/desktop/electron/main.ts` | 11 | both | enrollment, callback, routing, relay, spawn priority |
| `apps/desktop/electron/media-protocol.test.ts` | 1 | both | managed media/profile routing |
| `apps/desktop/package.json` | 1 | both | evaOS identity, updater, signing and managed tests |
| `apps/desktop/src/api/sessions.ts` | 1 | both | managed request ownership |
| `apps/desktop/src/app/contrib/controller.tsx` | 2 | both | settings and local mutation boundary |
| `apps/desktop/src/app/contrib/wiring.tsx` | 1 | both | managed capability scope |
| `apps/desktop/src/app/messaging/index.test.tsx` | 1 | both | managed provider branding |
| `apps/desktop/src/app/session/hooks/use-message-stream/gateway-event/desktop-bridge.test.ts` | 2 | both | routing / request ownership |
| `apps/desktop/src/app/session/hooks/use-message-stream/gateway-event/desktop-bridge.ts` | 3 | both | routing / relay / request ownership |
| `apps/desktop/src/app/session/hooks/use-message-stream/gateway-event/lifecycle.test.ts` | 2 | both | support-profile ownership |
| `apps/desktop/src/app/settings/config-settings.test.tsx` | 1 | both | settings gate / local denial |
| `apps/desktop/src/app/settings/providers-settings.tsx` | 1 | both | settings gate / local denial |
| `apps/desktop/src/app/shell/model-catalog-menu.tsx` | 1 | both | managed provider branding |
| `apps/desktop/src/components/onboarding/providers.tsx` | 1 | both | managed provider branding |
| `apps/desktop/src/i18n/context.tsx` | 1 | upstream | none |
| `apps/desktop/src/main.tsx` | 1 | both | enrollment / routing |
| `apps/desktop/src/store/profile.ts` | 2 | both | literal-default and unavailable-target behavior |
| `hermes_cli/mcp_startup.py` | 2 | both | MCP profile scope / lease auth |
| `package-lock.json` | 1 | both | dependency graph plus evaOS package identity |
| `tools/mcp_tool.py` | 1 | both | MCP profile live-state isolation |
| `tools/mcp_tool_discovery.py` | 1 | both | MCP profile live-state isolation |
| `tools/mcp_tool_handlers.py` | 2 | both | MCP request owner isolation |
| `tools/mcp_tool_health.py` | 1 | both | MCP profile live-state isolation |
| `tools/mcp_tool_registration.py` | 2 | both | MCP scope / request owner isolation |
| `tools/mcp_tool_server_run.py` | 1 | both | managed lease auth |
| `tools/session_search_tool.py` | 3 | both | r28.2 profile-scoped session search |
| `tui_gateway/server.py` | 1 | both | managed target / viewer boundary |
| `tui_gateway/session_lifecycle.py` | 1 | both | #261 session/viewer teardown |

Post-merge RED/GREEN corrections restored moved behavior in the new defining helpers: MCP compatible profile overlays (`8fd009c925`), direct-viewer detach before fanout rebind (`437c552de2`), and managed filesystem denial plus the agent-plugin root (`9e36ad7de4`). No managed invariant was weakened.

## Retained fork groups

The frozen recon records 324 non-merge fork commits since the r32 pin and zero patch-equivalents upstream by `git cherry`; no carried behavior is retired as upstream-equivalent. The managed groups remain Desktop identity/enrollment/updater, MCP live-state/scope/lease/request ownership, gateway/TUI teardown and profile targeting, profile/config migration guards, session search isolation, and managed runtime/support behavior. Historical commit counts are inventory, not proof; current tests and exact-head CI are the qualification evidence.

## Named risk gates

| Risk | Contract and named test | Receipt |
|---|---|---|
| RISK-1 | `tests/hermes_cli/test_r32_managed_startup.py::test_ticker_idle_retirement_requires_ssh_token` | GREEN in the 71-test risk group, exit 0. The bounded upstream log returned `64fe13a647` (unrelated retire-capture backup), `aeecb110f8` (retired model names), and `677e8ed8a4` (Desktop sticky SSH profile); none moves the ticker idle-retirement contract. PCS launchers pass no SSH session token (orchestrator fact). |
| RISK-2 | `tests/hermes_cli/test_r32_managed_startup.py::test_managed_startup_preserves_config40_and_soul_unmanaged_migrates` | RED before the merged guard/fixture port; GREEN in the 71-test group, exit 0. Managed config remains version 40 and config/SOUL are byte-identical; unmanaged config reaches 42 and removes `cron.model_drift_guard`. `cron.model_drift_guard`, `gateway.multiplex_profile_allowlist`, and `sessions.write_json_snapshots` have zero PCS-template hits (orchestrator-verified), so v42 removal is inert on fleet templates. |
| RISK-3 | `tests/tui_gateway/test_gateway_owned_session_reap.py`, `test_r32_viewer_attachment.py`, `test_desktop_ui_protocol.py` | RED: direct-viewer disconnect resurrected the old socket in upstream fanout. GREEN: 46/46 across three files, including all nine #261 cases, exit 0. |
| RISK-4 | `tests/test_tui_gateway_ws.py` | GREEN in the 71-test group, exit 0; heartbeat tripwire retained. |
| RISK-5 | `tests/tui_gateway/test_profile_target_unavailable.py`; literal-default cases in `eva-managed.test.cjs` and `eva-runtime.test.cjs` | Python case GREEN in the 71-test group; Desktop managed gate 223/223 GREEN, exit 0. |
| RISK-6 | `tests/gateway/test_hosted_rooms.py::test_default_db_path_never_names_the_master_session_store`; `tests/hermes_cli/test_web_server_boot_handshake.py::test_hosted_room_recovery_cannot_block_or_abort_backend_startup` | GREEN in the 71-test group, exit 0. PCS layout `/var/lib/evaos/hermes/<profile>` resolves to `<profile>/shared-state.db`; profile-directory layout resolves to root `shared-state.db`; resolution is lazy and a read-only-store failure cannot abort backend startup. PCS 0.1.119 must add `shared-state.db{,-wal,-shm}` to updater fingerprint and employee-distribution deny-list; restic includes are box-side. No PCS file changes here. |
| RISK-7 | Fork MCP files: gateway adapter/reload/multiplex, CLI managed scope/startup, TUI late refresh/profile RPC, and tools lease/approval/circuit/client-cert/config/initial/lazy/live-state/shutdown/resource/structured/core/401/session-expiry/failed-scope | RED: 5 multiplex failures exposed omitted shared-overlay state/helpers. GREEN: 25 files, 402 tests passed, exit 0; follow-up scoped lifecycle + multiplex 9/9, exit 0. Profile live-state isolation, scoped shutdown, request owner isolation, route/credential equality and managed lease auth remain. |
| RISK-8 | `tests/tools/test_session_search.py` and `tests/hermes_cli/test_web_server_session_search.py` | RED: stale test hook referenced the removed monolith helper. GREEN within the 402-test group, exit 0; no bare-ID sibling scan and active/routed profile confinement retained. |

Upstream commit `7a5fc1b2a9e57977e56ec040698ceaadd160171a` removes automatic JSON session snapshots. `tests/agent/test_session_snapshot_removal.py` is green; a source search finds only legacy snapshot deletion and explicit export/eval code, not a fork runtime reader of those snapshots. `sessions.write_json_snapshots` is therefore inert.

F1/41 remains unchanged: `ProtectHome=tmpfs` is mandatory. This source cut does not change that drop-in bar.

## Source qualification receipts

- Toolchain: `uv 0.11.26`, Python `3.12.13`; editable install `.[web,mcp,messaging]` succeeded. Homebrew Node `26.7.0` and npm `10.9.8` were used; the shadowed `~/.local/bin/node` was never used for accepted Desktop receipts.
- Frozen-base focused run: 1,896 files, 19,868 passed, 19 failed, 228 skipped; exit 1. Nine failure files are recorded in the cut artifact.
- Repaired-head focused run: 1,978 files, 20,469 passed, 18 failed, 244 skipped; exit 1. Six failure files remain: local mode normalization, SQLite diagnostic, three launchd expectations, missing pinned LCM checkout (three), and 10 updater cases reproduced unchanged at the exact upstream tag.
- Exact upstream-tag updater comparison: 10/32 failed (nine autostash plus one HEAD-movement) on the same Mac, exit 1; this bounds those failures as upstream-native local behavior rather than merge-resolution regressions.
- Full Python invocation (one pass): 4,011 files, 47,518 passed, 126 failed, 529 skipped; 12 ACP files did not collect; exit 1. The requested extras omit several optional provider and ACP dependencies. This is not a green full-suite claim; named r33 risk gates are independently green and exact-head CI remains required.
- Desktop: `npm ci` exit 0; typecheck exit 0; UI 7,652 passed, exit 0; platform 2,241 passed / 6 skipped after one RED managed-boundary correction, exit 0; managed 223 passed, exit 0. Local `npm run lint` is `ENVIRONMENT_BLOCKED`: package metadata has no direct `eslint`, and the same missing bootstrap exists on both frozen parents. No dependency or lockfile was changed to hide it.
- F8 is `ENVIRONMENT_BLOCKED`: the requested `scripts/eval/probe_session_smoke.py` exists in neither frozen parent nor the merged tree. No substitute smoke or customer/runtime action was performed.

## Current review dispositions

- MCP shared profile overlay omission: `MERGE_BLOCKING / FIXED NOW` in `8fd009c925`; 402-test MCP/session gate plus scoped lifecycle rerun are green.
- Viewer socket resurrection through fanout: `MERGE_BLOCKING / FIXED NOW` in `437c552de2`; 46-test teardown/protocol gate is green.
- Desktop plugin-root managed denial/handler omission: `MERGE_BLOCKING / FIXED NOW` in `9e36ad7de4`; platform and managed gates are green.
- Review delta: `MERGE_BLOCKING / FIXED NOW` in `8b7b219ea8`. It removes six generated `MagicMock` database/lock artifacts, binds saved TOTP generation to the saved origin, rejects symlinked config-backup sources, prevents a concurrent free-tier waiter from blocking or duplicating the elected owner, requires the exact 40-character upstream SHA in the reusable plugin validator, and disables persisted checkout credentials in plugin-catalog CI. The three new runtime tests were RED together (exit 1), then GREEN together (3/3, exit 0); all 90 tests in their three files pass.
- Installer result-chart token scope: `RELEASE_BLOCKING / FIXED NOW` in `582e632a4f`. The imported workflow queried run jobs and artifacts while its explicit token policy left `actions` at `none`; the report job now has least-privilege `actions: read` plus `contents: read` for checkout. `actionlint .github/workflows/install-e2e.yml` passes (exit 0); no installer matrix or release was run in this source-only lane.
- Bootstrap-installer `0.21.1` metadata: `RELEASE_BLOCKING / ESCALATED TO THE PAIRED DESKTOP RELEASE`. This lane deliberately does not stamp or publish Desktop/installer versions; the r33 release note assigns Desktop es.7 pairing to the next cadence gate.
- Vault pixels after a secret fill and an unmatched persisted `/steer` tail: `RELEASE_BLOCKING / ESCALATED TO THE ORCHESTRATOR REVIEWS`. Both are upstream-owned cross-surface design concerns outside the named managed cut paths; neither is treated as security clearance. The cut does not broaden either surface before the required blind acceptance/adversarial review.
- Source-reading tests and stale optional `rss-feeds` consumer text: `NON_BLOCKING / ESCALATED AS UPSTREAM FOLLOW-UP PROPOSALS`. They violate repository test/doc shape but do not reproduce a failure in the named r33 managed operating path; the spent review delta does not reopen unrelated refactors or optional-skill documentation.
- CodeQL inline alerts for Desktop plugin materialization, the local install-evidence player, OAuth test data, and credential-rotation logging: `NON_BLOCKING / FALSE OR NOT APPLICABLE`. The first writes under the configured app plugin root rather than an attacker-selected temp file; the next two are test/evidence fixtures; the logging alert points at route/model identifiers while its taint trace originates elsewhere. This is not a dismissal of the aggregate CodeQL report.
- CodeQL alert aggregation: `NON_BLOCKING / QUALIFICATION BOUNDARY`. All language analysis jobs pass; aggregation reports the full 986-commit upstream delta as new alerts. The source-cut PR does not dismiss alerts or claim a security release gate.
- Upstream-native Mac updater tests: `NON_BLOCKING / ACCEPTED TRADEOFF FOR LOCAL QUALIFICATION`; exact upstream tag reproduces all 10 and exact-head CI is the portable gate.
- Optional-provider/ACP full-suite failures: `NON_BLOCKING / QUALIFICATION BOUNDARY`; the user-directed install extras omit those dependencies. No current named r33 path failure is established.
- Orchestrator blind acceptance and adversarial reviews: pending after this cut receipt by explicit lane contract; this lane does not self-review or claim their coverage.

## Qualification boundary

This ledger and the PR qualify source plus exact-head CI only. They do not create a runtime tag or Desktop release, install any runtime, modify PCS, prove fleet state, or prove a customer session. The orchestrator owns the two blind reviews, merge, immutable runtime prerelease, PCS 0.1.119, and Benjamin canary after A8.
