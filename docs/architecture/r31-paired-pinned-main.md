# ADR: paired pinned-main updates without migration

Status: accepted design; implementation and release proof pending.

Work graph: [r31.1 epic #252](https://github.com/electricsheephq/evaOS-hermes-desktop-app-adapter/issues/252), milestone 12. Supersedes moving-main execution instructions for this release, not the previous release's evidence.

## Decision

Runtime and Desktop use one reviewed final fork tree with upstream pinned to `f159e581c7afd22a5c94652c569e3859f1b994d2`. Merge that immutable source without rewriting published history, then port managed behavior into its defining modules. Do not keep obsolete monoliths or compatibility facades to avoid doing the port. The release does not follow a moving branch.

Keep the current package installer, per-profile services, authentication authority, external LCM and Mac updater. Update code in place. No account, user, unit, profile, home, store or credential relocation is part of this change. Deleting managed code is optional and requires demonstrated upstream equivalence plus behavioral tests.

## Authorities and trust boundaries

| Concern | Owner / invariant |
|---|---|
| GUI, Preview rendering and interaction | The user's Mac/Electron app. The VM remains headless. |
| Session and agent execution | Existing assigned runtime and profile, not whichever GUI or profile is foreground. |
| Enrollment and routing | Existing managed broker assignment and encrypted enrollment. Client capability metadata grants no authority. |
| Provider authentication | Existing shared-auth provenance, lock and writeback contract; no credential reset, plaintext fallback or weakened Keychain access. |
| MCP access | Assignment-bound in-memory leases; endpoint/auth/app-aware discovery and schema cache. |
| Persistent state | Existing profile homes, config, sessions and LCM stores; only idempotent additions proven readable/writable by the predecessor. |
| Release selection | Immutable runtime identity; existing Desktop GitHub latest stream. A runtime release must not displace Desktop latest. |

## UI protocol evolution

Extend only `desktop_ui_protocol`, on the existing session create/resume/activate lifecycle, to level 3. Missing/invalid Desktop metadata stays legacy-safe; non-Desktop sessions have no GUI access. Rebinds preserve session ownership, attachment identity and cache-safe tool behavior.

| Level | Supported surface |
|---|---|
| 1 | Legacy-safe tools; consolidated `desktop_preview` action `open` only. |
| 2 | Existing v2 responders, including Preview read/close. Never `tip.show`. |
| 3 | New pinned-main responders, including `show_tip` / `tip.show`. |

Schema filtering is action-aware, not just tool-name-aware. Independently enforce the same minimum immediately before dispatch/emission/wait, including aliases, tool search and retained/direct calls. Unclassified actions are unavailable. Capability is not authorization: only the owning active session controls its surface, and background/cross-owner requests must not inspect or drive a foreground GUI.

`open` remains fire-and-forget where upstream does so. Its success means dispatched, not rendered. The installed canary separately observes rendering.

## Persistence and upstream refactors

Keep the managed early return before upstream's heuristic active-profile migration; test boot and reconnect without removing the feature for unmanaged users. Preserve existing managed config values through v39→v40; if upstream normalizes defaults, use backward-compatible in-memory interpretation instead of deleting persisted settings.

Exercise old FTS-v1 and candidate-created stores through old → new write/restart → old read/append. Do not run optimize-storage, rebuild databases or convert stores during rollback. Any incompatible persistent write blocks promotion.

LCM remains v0.20.0 at `49e99a272d2d461e5c90732e7ef2bc20e96f0826`. Actual plugin loading, context calls and native dispatch must pass before/after the September 14 import cutoff with overrides disabled. A required external import correction is a narrow separate change, not engine replacement.

Adopt additive owner-scoped composer keys while preserving legacy keys and predecessor behavior. Preserve heartbeat until equivalence satisfies #145's deletion tripwire. The unused Desktop media-grant codec may retire only after reachability, packaging and media tests pass.

## Release order and rollback

1. Synthetic compatibility, managed parity and exact-source checks.
2. One blind acceptance and one blind adversarial implementation review, each PASS ≥95, plus terminal findings and the final live merge barrier.
3. Merge/reconcile actual source; build both release sets from that tree. Freeze runtime artifact before dependent existing-format PCS pins. Its candidate PR stays unmerged; defaults stay unchanged.
4. One existing internal runtime update via the verified exact-commit installer, with the same users/units/paths/homes; existing synthetic conversation on the current Mac.
5. Final signed Mac preserved-enrollment/cold-restart/process-exit/Preview acceptance; only then public Mac promotion.
6. Actual predecessor-to-published in-app updater and repeat acceptance.

Preserve the current Mac v2026.8.27-es.1 and verified deployed r30.7 predecessor. A failed install restores the affected predecessor immediately with stores in place. Failed public Mac acceptance also restores previous latest and marks the failed release prerelease, retaining immutable assets. Feed rollback prevents new offers; it cannot downgrade clients already updated.

## Proof boundary

The ledger and release packet bind design to exact evidence. Planning review is not implementation review. Source, artifact, installed/internal and employee/fleet claims stay separate. This milestone does not close #242's employee acceptance or authorize customer rollout, Golden/default promotion, loopback proxy, dashboard, VM GUI or arbitrary Mac control.
