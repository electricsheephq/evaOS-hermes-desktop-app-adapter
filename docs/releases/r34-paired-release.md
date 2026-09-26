# r34.0 paired release

Base `006e26669ff96f680b547580ce6405e83549d480` merges upstream `v2026.9.24` / Hermes `0.21.5` at `f97608f178d1ffeca59860195ab7da295f7c8e5f`, with merge-base `939e45c91d751fadd94dcd1b873ac3cb44846213` and merge commit `1320bfe883070cbafa618c65d0a8f52787388a2f` (PR #362); conflict resolutions, RISK receipts, the legacy prompt shim and the compat sources are recorded in [the r34 managed-delta ledger](../r34-managed-delta.md). This cycle changes the Desktop↔runtime protocol and a managed plugin identity, so it runs under the [2026-09-25 cadence amendment](../architecture/upstream-sync-cadence.md). This document binds the release inputs and gates; it creates no tag and proves no installed, fleet or customer state.

## Identity set

| Surface | Frozen input / planned output |
|---|---|
| Upstream | `v2026.9.24`, Hermes `0.21.5`, `f97608f178d1ffeca59860195ab7da295f7c8e5f` |
| Runtime predecessor | r33.6, `evaos-runtime-es.12-v0.21.2-r33.6` / `2d10969e7d6fab477c4aa4f7e4c9e4df1f524e9a`, the fleet's last serving runtime; deployed identity must be read back per box |
| Planned runtime | `evaos-runtime-es.12-v0.21.5-r34.0`, a GitHub prerelease with zero assets (amendment rule 6), cut from `main` after PR-1 (#362), PR-2 (#369), PR-2b and PR-3 merge |
| Source PRs in the tree | #362 upstream merge; #369 legacy prompt shim; PR-2b es.9 connector replies; PR-3 compat sources and this document; #365, #366, #367 (adapter#359, #360, #361) |
| LCM-X plugin | v0.24.1 / `98ac62fee5316cdf461e77f28951720f523489f1` (electricsheephq/lcm-x, tag object `ff6035202e405e3d6e613c416890a1b0eb191633`); plugin `hermes-lcm-x`, context engine `lcm-x`, replaces plugin name `hermes-lcm` |
| LCM-X managed payload | `lcm-x-0.24.1-managed.tgz`, sha256 `9015562a8e488d19cc54e31209e8fd168a51abb46e6069f0f6e50d3ccedbeab1`, content digest `cc38ae0bc86885112c531f9964dae36e0890d816a0eba606bd97be576492f7e6`, pin `lcm-x-managed-plugin.v1.json` (all v0.24.1 release assets) |
| PCS | 0.1.143 (managed payload builder, #957; LCM-X migrate/rollback modes, #959), 0.1.145 (the #959 label after review), 0.1.146 (#961 follow-ups). These carry the v0.24.0 candidate pin (`f3e56f9c…`, source `d346ab9e…`); the v0.24.1 pin is a separate PCS label that must merge before the first box |
| Desktop | es.10 (adapter#356): built from the r34 tree, held as a DRAFT release until the last box runs r34, then published. es.9 stays the published Desktop during convergence |

The runtime tag SHA, the PCS pin PR, artifact digests read back on a box and review links are execution outputs; do not publish placeholders as proof.

## Required compatibility

- es.9 on r34: the legacy prompt shim (ledger §SHIM, kill switch `HERMES_EVAOS_LEGACY_PROMPT_SHIM=0`) answers clarify, sudo, secret, tour and vault prompts from pre-es.10 clients; PR-2b carries the es.9 connector replies (RELEASE_BLOCKING for customers, ledger KNOWN GAPS). `tests/r34_compat/test_es9_session_bind_wire.py` binds every es.9 create/resume/activate shape with the predecessor's protocol marker.
- Managed profiles: no on-disk config migration or stamp under `HERMES_MANAGED_DIR` (R1; `tests/r34_compat/test_managed_dir_guard.py` against r33.6).
- State DB: r33.6 ↔ r34 round trip in both directions (`tests/r34_compat/test_state_rollback_compat.py`).
- LCM-X: the pinned source loads as `hermes-lcm-x` / `lcm-x` from a config that names only the new identity (`tests/r34_compat/test_pinned_lcmx_plugin.py`). The plugin rename is a config change PCS performs (`plugins.enabled`, `context.engine`); a box that enables only `hermes-lcm` falls back to the built-in compressor.

## Shim window

Rule 5 of the amendment: boxes converge on r34 with the shim serving es.9 first; the Desktop feed (es.10) is published only after the last box. Desktop fixes during convergence ship as point releases from the es.9 tag. The shim is deleted in the cycle after every supported Desktop client is confirmed on es.10 (per-person adoption proof, not feed publication) and box logs show no `legacy prompt shim served` line over the observation window; the deletion recipe is in the ledger §SHIM.

## Canary order and soak bar

Canary order: internal → wave 1 → wave 2 → wave 3 → wave 4 → wave 5 → wave 6, one box per window, via the box rung with custodian and refuter. The cycle is done when `fleet_runtime_sha_variants = 1` on the r34 tag and the PCS pin is merged.

Soak bar (amendment rules 3–4): 7 consecutive clean days on the internal canary on the FINAL runtime and plugin bytes and the FINAL Desktop build the canary users run. A runtime, plugin or Desktop protocol-path byte change restarts the clock; a Desktop change outside the protocol path or a config-only repair gets a 24 h re-check with the clock running. Clean means: 0 unclassified and 0 runtime/plugin-attributable tracebacks by the class ledger; each known external-credential class within its pre-flip 24 h baseline in count (grow) and in affected profiles and boxes (spread); a new class is red until classified within 24 h; every restart attributed to a recorded intent, a connector sync, a plugin backup stamp or host maintenance.

## Rollback

Per box, on a red bar only, the operator kit `RERUNG-r34` (support-control, merged in sc#1016): stop both units; if the profile was migrated, PCS `rollout-lcm-x-profile.sh rollback` re-enables `hermes-lcm` from the frozen v0.23.3 pin and unlinks `hermes-lcm-x`; restore `state.db` from the pre-flip backup the driver takes before each rung (r34 moves FTS storage v2 → v3 on first open); re-rung on the predecessor runtime and read back. The LCM-X rollback is configuration plus plugin payload only: the live `lcm.db` stays in place, and its pre-migrate copy is restored only if v0.23.3 cannot open it. A failed canary holds the cycle: no feed flip, no PCS pin, predecessor restored (Decision rule 6). `tests/r34_compat/test_state_rollback_compat.py` shows r33.6 still reads, appends and searches a state.db that r34 opened or created; the kit does not rely on it.

## What this release does NOT prove

- The compat suite is synthetic and single-host: temporary homes and databases, no model calls, no live gateway, no installed runtime, no box.
- LCM-X store continuity across a runtime or plugin rollback is not in CI; only the v0.24.1 plugin's own restart on one store is. A v0.23.3 compaction after a rollback is unmeasured (lcm-x#471).
- The shim is proven against a recorded es.9 inventory and in-process transports, not against an installed es.9 Desktop. GUI reads (`terminal.read`, `preview.*`, `window.read`) and `connection.request` stay uncovered for es.9-only sessions.
- Upstream's `e2e`, `e2e-upgrade` and `Desktop core E2E` jobs are opt-in and have never passed on the fork (adapter#363).
- Passing CI is not a release, and one internal canary is not employee, fleet or customer success; `customer_ready` needs real end-user sessions.
