# r31.1 managed-delta ledger

This ledger maps retained behavior into pinned upstream modules. It supplements the actual Git diff, never substitutes for it. Preserve [the previous 8.27 ledger](desktop-v2026.8.27-managed-delta.md) unchanged.

## Identities

- Target upstream: `f159e581c7afd22a5c94652c569e3859f1b994d2`.
- Released runtime r30.7: `d02f246755153b318d472e30abb960f8578f8cfa`, based on upstream `5fc308a70719a83cccdbba4c0e39c23f5a8239d5`.
- Runtime protocol input #244: `1097faddff7df3c4786bab592d22dd4b952b5d0a`.
- Released Desktop/fork main: `7a99c3ebae8ed6f264d71afab3ef1b2a52f45376`.
- Work: #252, #253, #39 and #254. Candidate/merged SHA is an execution output.

Fork main is not the complete released runtime overlay. Compare runtime against its own released source and Desktop against its own released source. KEEP/PORT below are design dispositions, not completed parity evidence.

The live Git merge base of released fork main and the pinned target is `4075c8fd5ade673c93f757903b003ddc52603577`. The historical 8.27 ledger contains a different, unresolvable common-ancestor string; that ledger is preserved as historical evidence, not used to select source. Runtime replay is the exact `5fc308a…` → `d02f246…` delta; Desktop replay is the exact `5fc308a…` → `7a99c3e…` Desktop delta.

| Capability | Released source | Target module(s) / disposition | Required regression evidence |
|---|---|---|---|
| Managed flat profile/service scope | `hermes_cli/managed_profile_scope.py`, `profiles.py`, web profile routes | KEEP policy; PORT to current profile/web defining modules | Default/sibling denial, boot/reconnect, same user/home/unit |
| Shared provider authentication | `agent/credential_pool.py`, `hermes_cli/auth.py` | KEEP provenance/locks/writeback; PORT into split auth modules | Concurrent refresh, three-way merge, source provenance, protected modes |
| Protected managed config | `config.py`, `env_loader.py`, `managed_scope.py`, `mcp_startup.py` | KEEP boundary; PORT current entrypoints | No managed persistent v39→v40 value deletion; reload scope |
| Assignment MCP lease | `tools/evaos_mcp_lease.py`, `mcp_tool.py` | KEEP lease; PORT split transport/discovery/health/server paths | Memory-only, endpoint/app/identity bind, one 401 recovery, no redirect/proxy leakage |
| MCP schema cache | `tools/mcp_schema_cache.py` | KEEP auth/app-aware fingerprint | Cross-principal/app denial and reconnect |
| Search and supervisor identity | `session_search_tool.py`, gateway/server | PORT current defining modules | Profile-isolated search; exact restart PID/start-time/argv/service identity |
| GUI session protocol | #244 agent/tool/session/server modules | PORT existing guarantees; extend same field to 3 | Per-action schema+dispatch inventory, owner attachment, lifecycle/reuse, immediate denial |
| Managed Desktop enrollment | `eva-managed.cjs`, `eva-runtime.cjs`, Electron main/preload | KEEP strict encryption and native read ordering | Preserved enrollment, cold restart, fail-closed without reset/plaintext |
| Callback/routing/relay | Managed protocol, deep-link, connection-owner and WS relay modules | PORT owning upstream modules | PKCE/state callback, assignment/delegation, owner-isolated replies and reconnect |
| Product/update identity | Branding/build/updater/signing tooling | KEEP existing identity/stream/profile | Exact-source signed assets, normal quit and actual updater |
| Preview and media | Gateway handlers, media protocol, assigned runtime requestMedia | PORT current responders, protocol3 | Public open/read/elements/close; owner/media denial |
| Owner-scoped composer persistence | Upstream additive registry keys | ADOPT with legacy keys retained | Cross-profile isolation and predecessor key readback |
| Unused media-grant codec | `electron/eva-media-grant.cjs` | RETIRE candidate only | No reachable/package consumers; media contracts pass before deletion |
| Heartbeat | Existing runtime contract #145 | KEEP; no equivalence proven | Preserve deletion tripwire |
| LCM | External v0.20.0 at `49e99a…` | KEEP unchanged | Actual loader at cutoff, engine/tool calls, same-store restart and predecessor append |

## Evidence status

The first synthetic compatibility gate passed before the broad port. The [#254 receipt](https://github.com/electricsheephq/evaOS-hermes-desktop-app-adapter/issues/254#issuecomment-5548307272) records the exact fixture inputs and limits: state/config 5/5, pinned LCM 5/5, protocol 9/9, GUI inventory 10/10, managed boot 2/2, Astra 4/4 and upstream ownership 19/19. Those local proofs are not integrated-source CI, installed or release acceptance.

Normal merge `374134afd9e6c377120b7c8b31eee82d64d60f85` has parents `5d961f575e14e72ec91a0f0c6ffa9c48832e1466` and the frozen upstream target. It starts from the exact upstream tree and preserves 81 adapter-only paths for managed replay. Upstream's renamed/retired paths are not resurrected; their history remains in the merge parents. Upstream-imported whitespace is unchanged baseline, while authored deltas must pass `git diff --check`.

Root port `2d7305b325` restores the existing package/bundle/update identity, exact-certificate signing hook, fail-closed release notarization configuration, media endpoint routing and standard GitHub-hosted runner topology. It retains all selected upstream checks and restores the managed E2E classifier/export/aggregate requirement. The classifier regression first failed on the absent composite-action export, then passed 68/68; notarization configuration passed 4/4. Commit `d0e24b501f` also keeps upstream website deployment restricted to upstream and removes its unavailable Nix runner label without removing Nix checks.

Protocol implementation `baf71de5a2` and inventory `0dc645e676` are integrated; the per-action contract passed 9/9 at `d0e24b501f097146924458009f38c7a5e5f98cc7`. Full #244 lifecycle parity remains pending. The broader runtime/auth/MCP/profile and Desktop ports, every retirement, exact-head CI, independent implementation review and protected canaries remain PENDING. Replace those pending rows with exact commit/test/CI links when proven; file presence is not parity.
