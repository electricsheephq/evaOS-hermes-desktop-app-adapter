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

First synthetic fixtures are being created against the target before broad porting. All production-port and retirement rows are PENDING. Replace each pending row's evidence with exact commit/test/CI links when proven; do not infer parity from file presence or an upstream release note.
