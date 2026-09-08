# r32.0 managed-delta ledger

Successor to [r31](r31-managed-delta.md), under [the paired-source ADR](architecture/r31-paired-pinned-main.md) and [cadence #272](architecture/upstream-sync-cadence.md). This is source qualification only; release, installation, fleet and customer gates belong to the orchestrator.

## Frozen source identities

- base: `3a0c02e26dac11cc9b2c6c394db684b6081439f6`.
- upstream: `2237be355906fbe6065ce1815711eee52b2d646e`.
- merge_base: `f159e581c7afd22a5c94652c569e3859f1b994d2`.
- merge_commit: `606bc80724f1c731e68025efb8775640ae93bb33`.
- merge_tree: `c9e22f4192c7b759cdb2ec3833e95c6dec97ea31`.
- Upstream tag: `v2026.9.7`, package version `0.21.1`.
- Planned runtime tag (not created by this lane): `evaos-runtime-es.12-v0.21.1-r32.0`.
- The merge has exactly the base and upstream commits as its two parents. Merge this PR with a merge commit, never squash or rebase; preserve the upstream parent.
- The merge tree above is the initial resolved merge, before separately tested conflict-cluster corrections. The PR head and final CI identify the completed candidate; a commit cannot embed its own final hash.

## Conflict resolution

The live merge reproduced recon: 19 files, 39 content hunks, no rename/delete conflicts. Choices: 1 upstream, 2 ours, 36 both-merged. Upstream logic wins except the named managed contract; moved behavior follows the new defining helper.

| File | Hunk | Choice | Why | Managed invariant / fork commit |
|---|---|---|---|---|
| `agent/credential_pool.py` | hunk 1 | both-merged | Retain additive upstream and managed behavior | managed scope / identity |
| `agent/credential_pool.py` | hunk 2 | both-merged | Adopt admin mixin and retain source/shadow constructor | shared-auth provenance |
| `agent/credential_pool.py` | hunk 3 | both-merged | Retain additive upstream and managed behavior | managed scope / identity |
| `agent/credential_pool.py` | hunk 4 | both-merged | Use upstream admin mixin; port source-aware removal and shadow ownership there | shared-auth locks/writeback |
| `hermes_cli/auth.py` | hunk 1 | both-merged | Preserve three-way source writeback and explicit reset semantics | shared-auth provenance/locks/writeback |
| `hermes_cli/auth.py` | hunk 2 | both-merged | Preserve three-way source writeback and explicit reset semantics | shared-auth provenance/locks/writeback |
| `hermes_cli/auth.py` | hunk 3 | both-merged | Preserve three-way source writeback and explicit reset semantics | shared-auth provenance/locks/writeback |
| `hermes_cli/web_server_profiles.py` | hunk 1 | both-merged | Keep upstream nested scope behavior behind managed guard | managed profile boundary |
| `tests/agent/test_compression_attempt_lifecycle.py` | hunk 1 | ours | Preserve #261 bounded cooperative teardown timing fixture | fork #261 |
| `tools/mcp_tool_discovery.py` | hunk 1 | both-merged | Store upstream health ownership by managed state key | MCP profile live-state isolation |
| `tools/mcp_tool_lifecycle.py` | hunk 1 | ours | Retain tuple-key scope cooldown selection including failed connections | MCP scoped shutdown #8263285980 |
| `tools/mcp_tool_lifecycle.py` | hunk 2 | both-merged | Clear upstream status only for selected profile; preserve scoped cooldown order | MCP profile live-state isolation |
| `tools/mcp_tool_lifecycle.py` | hunk 3 | both-merged | Clear upstream status only for selected profile; preserve scoped cooldown order | MCP profile live-state isolation |
| `tools/mcp_tool_lifecycle.py` | hunk 4 | both-merged | Clear upstream status only for selected profile; preserve scoped cooldown order | MCP profile live-state isolation |
| `tui_gateway/methods_session.py` | hunk 1 | both-merged | Keep upstream resume locking/refusals and bind caller protocol/source before rebind | GUI session attachment ownership |
| `tui_gateway/methods_session.py` | hunk 2 | both-merged | Keep upstream resume locking/refusals and bind caller protocol/source before rebind | GUI session attachment ownership |
| `tui_gateway/methods_session.py` | hunk 3 | both-merged | Keep upstream resume locking/refusals and bind caller protocol/source before rebind | GUI session attachment ownership |
| `tui_gateway/model_switch.py` | hunk 1 | both-merged | Use upstream rebuild helper with negotiated protocol | GUI protocol3 |
| `tui_gateway/server.py` | hunk 1 | both-merged | Keep unavailable-target rejection and managed guard; viewer metadata ported to rebind helper | managed profile / attachment boundary |
| `tui_gateway/server.py` | hunk 2 | both-merged | Keep unavailable-target rejection and managed guard; viewer metadata ported to rebind helper | managed profile / attachment boundary |
| `apps/desktop/electron/main.ts` | hunk 1 | both-merged | Retain managed backend/media/assignment gate with upstream priority and session routing | managed enrollment and callback/routing/relay |
| `apps/desktop/electron/main.ts` | hunk 2 | both-merged | Retain managed backend/media/assignment gate with upstream priority and session routing | managed enrollment and callback/routing/relay |
| `apps/desktop/electron/main.ts` | hunk 3 | both-merged | Retain managed backend/media/assignment gate with upstream priority and session routing | managed enrollment and callback/routing/relay |
| `apps/desktop/electron/main.ts` | hunk 4 | both-merged | Retain managed backend/media/assignment gate with upstream priority and session routing | managed enrollment and callback/routing/relay |
| `apps/desktop/electron/main.ts` | hunk 5 | both-merged | Retain managed backend/media/assignment gate with upstream priority and session routing | managed enrollment and callback/routing/relay |
| `apps/desktop/src/api/config.ts` | hunk 1 | both-merged | Use upstream API wrapper with captured managed capability scope | managed request ownership |
| `apps/desktop/src/api/config.ts` | hunk 2 | both-merged | Use upstream API wrapper with captured managed capability scope | managed request ownership |
| `apps/desktop/src/api/mcp.ts` | hunk 1 | upstream | Adopt upstream OAuth RPC; surrounding function already retains capability scope |  |
| `apps/desktop/src/app/settings/index.tsx` | hunk 1 | both-merged | Keep managed onboarding and upstream settings scope imports | managed settings gating |
| `apps/desktop/src/app/settings/providers-settings.test.tsx` | hunk 1 | both-merged | Retain both managed Accounts and upstream settings target cases | managed branding / local CLI denial |
| `apps/desktop/src/app/settings/providers-settings.tsx` | hunk 1 | both-merged | Keep managed endpoint denial while adopting settings scope | managed local mutation denial |
| `apps/desktop/src/app/settings/providers-settings.tsx` | hunk 2 | both-merged | Keep managed endpoint denial while adopting settings scope | managed local mutation denial |
| `apps/desktop/src/app/shell/model-catalog-menu.tsx` | hunk 1 | both-merged | Combine separator matching and managed display branding | managed provider branding |
| `apps/desktop/src/components/assistant-ui/mcp-setup-tool.tsx` | hunk 1 | both-merged | Use upstream OAuth bridge bound to owning session rather than foreground | MCP request owner isolation |
| `apps/desktop/src/components/assistant-ui/mcp-setup-tool.tsx` | hunk 2 | both-merged | Use upstream OAuth bridge bound to owning session rather than foreground | MCP request owner isolation |
| `apps/desktop/src/components/assistant-ui/mcp-setup-tool.tsx` | hunk 3 | both-merged | Use upstream OAuth bridge bound to owning session rather than foreground | MCP request owner isolation |
| `apps/desktop/src/components/model-visibility-dialog.tsx` | hunk 1 | both-merged | Combine upstream separator matching with managed display value | managed provider branding |
| `apps/desktop/src/components/model-visibility-dialog.tsx` | hunk 2 | both-merged | Combine upstream separator matching with managed display value | managed provider branding |
| `apps/desktop/vitest.config.ts` | hunk 1 | both-merged | Union dedicated node:test exclusions; preserve explicit runner coverage | managed release test routing |

## Retained fork groups

Ancestry re-verification finds 312 non-merge fork commits since `f159e581`. Cherry comparison finds eight patch-equivalent commits across the two sides, all verified empty-tree CI retriggers; no substantive fork behavior is proven upstream-equivalent and none is retired on that basis. Approximate groups from the recon inventory are Desktop branding/enrollment/updater (90), MCP isolation/leases/cache/approvals (40), gateway/TUI teardown and notification durability (35), profile scope (35), delegated support (30), shared auth (20), and miscellaneous (62). Counts describe historical groups, not test coverage.

Existing [r31 evidence](r31-managed-delta.md) remains historical evidence. Current re-verification uses the focused suites, managed Desktop checks, and exact-head CI recorded by this PR. The current cycle does not replace shared auth, external LCM, broker assignment, profile homes, services, or updater identity.

## Named risk gates

| Risk | Contract and tests | Receipt |
|---|---|---|
| RISK-1 | `tests/hermes_cli/test_r32_managed_startup.py::test_ticker_idle_retirement_requires_ssh_token` | Sensitivity RED: forcing isolation in memory fails the no-token arming assertion (exit 1). GREEN: token-free ticker startup never arms retirement past simulated 900-second grace (startup suite 3/3, exit 0). Token-present SSH-isolated serve may retire despite a due job: it is explicitly unsupported as a persistent ticker host. PCS launchers have no SSH session-token flag (orchestrator-provided fact, not a fleet read by this lane). |
| RISK-2 | `tests/hermes_cli/test_r32_managed_startup.py::test_managed_startup_preserves_config40_and_soul_unmanaged_migrates` | Sensitivity RED: removing only the early managed guard in memory fails the version-40 assertion (exit 1). GREEN: managed startup/config load preserves version 40 and byte-identical config/SOUL (startup suite 3/3, exit 0); unmanaged startup executes `hermes_cli/config_migrations.py::_migrate_to_41`, strips the legacy section from root and sibling SOUL, and advances version. |
| RISK-3 | `tests/tui_gateway/test_gateway_owned_session_reap.py` and `test_r32_viewer_attachment.py` | #261 real SQLite teardown cases 9/9 GREEN; helper metadata test RED on upstream rebind (float replaced negotiated metadata), then GREEN after port. Four gateway files together 18/18, exit 0. |
| RISK-4 | `tests/test_tui_gateway_ws.py` | #145 heartbeat advertisement/inline ping tripwire 7/7 GREEN, exit 0. Upstream-only unused heartbeat driver deletion retained. |
| RISK-5 | `apps/desktop/electron/eva-managed.test.cjs` and `eva-runtime.test.cjs` plus `tests/tui_gateway/test_profile_target_unavailable.py` | Upstream unavailable-target test GREEN; managed literal-default native regressions pass in the 220-test managed Desktop run (exit 0). |

Startup tests: 3/3 GREEN, exit 0; the first run's two failures were fixture-only missing bound-server state, not a product regression. The later RED controls described above are deliberately broken in-memory variants, not failures of the committed guards. Shared-auth administration: managed shared-remove denial RED at the merge baseline, then all 20 profile-fallback tests GREEN, exit 0, after porting the guard and shadow ownership to `agent/credential_pool_admin.py`.

F1/41 remains unchanged: `ProtectHome=tmpfs` is mandatory; upstream user-bus adoption cannot make a namespace-hidden socket visible.

## Source qualification receipts

- Frozen-base focused command: 1,039 files, 11,308 passed, 13 failed, 159 skipped; exit 1.
- Initial merged focused command: 1,082 files, 11,619 passed, 22 failed, 186 skipped; exit 1. Targeted corrections and fixture-location adjustments pass: 78 tests, then restored 132 tests across nine files; exit 0. The remaining four focused Mac failures (SQLite diagnostic and three launchd/update expectations) also failed on the frozen base.
- Pinned external LCM fixture: explicit immutable source checkout, five tests passed (including three previously blocked by the missing default sibling path); exit 0.
- One full Python invocation: 3,862 files, 45,876 passed, 209 failed, 487 skipped, plus 11 collection/import-error files; exit 1. This is not a green-suite claim. Requested install extras omit optional providers/ACP; short temp paths under the checkout trigger repository/permission assumptions. An autostash fixture reset uncommitted test edits to HEAD during the run. The production commits remained intact; fixture deltas were restored and re-proven. The narrow Git-discovery ceiling in that test now passes with the cut reflog unchanged.
- Desktop managed checks: 220 passed; typecheck exit 0. Initial Vitest: 9,610 passed, four failed, six skipped; three fixture corrections pass, and the fourth was the synthetic HOME exceeding the Unix socket limit. Final `check:test:ui`: 7,445 passed, exit 0. Final isolated `check:test:desktop:platforms`: 2,168 passed, one synthetic-HOME socket-path failure, six skipped, exit 1; that exact socket case passes with a short synthetic HOME, exit 0. Temporary fixtures outside the checkout preserve repository identity.
- F8: pinned PCS `probe_session_smoke.py` client module driven against a worktree `serve`, scratch HOME under `/var/tmp`, and a synthetic loopback model. Session create, one completed turn, history readback, stored `source: eval-smoke`, and close/delete cleanup passed; exit 0. No provider, service installation or customer qualification is implied.
- Independent read-only boundary review: PASS at `348d443cbd61f2874e42ef27c92d927d04135f69`; no verified blocker. Later changes are tests/docs only, so the inspected production surface is unchanged. Covered shared auth, MCP scope/shutdown, session/viewer preservation, managed Desktop scope/gates, and managed startup guard.
- Frozen base CI itself had a failed kernel-eviction case in run `34237891248`; the corresponding 13-test file passed locally on this cut. Final PR CI must still reach its own exact-head terminal state.

## Qualification boundary

The PR and cut receipt carry final baseline-versus-branch failures, exact-head CI and review dispositions. Pending tests or CI never count as passing. No runtime tag, binary, installed Mac/runtime, fleet or customer proof is produced here. Desktop es.6 pairing is a follow-up under cadence rule 2.
