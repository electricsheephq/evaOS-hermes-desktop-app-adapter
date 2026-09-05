# r31.1 release and compatibility packet

Status: planned runtime and Desktop ports are integrated; focused source gates pass. Exact-source CI/security and independent implementation review remain pending before merge. Artifacts and protected canaries have not started. Canonical release gate [#255](https://github.com/electricsheephq/evaOS-hermes-desktop-app-adapter/issues/255), epic #252 and milestone 12.

The current MCP correction restores existing profile-owned live connections after the upstream module split, including same-name discovery and profile-specific shutdown. Its focused RED/GREEN receipts are in the [ledger](../r31-managed-delta.md). Prior-head CI and review cannot satisfy the final corrected-head gate. This repair changes neither the update path nor the persistent data format.

## Identity set

| Surface | Frozen input / planned output |
|---|---|
| Upstream | `f159e581c7afd22a5c94652c569e3859f1b994d2` |
| Runtime predecessor | r30.7 / `d02f246755153b318d472e30abb960f8578f8cfa`; deployed identity must be read back |
| Mac predecessor | `v2026.8.27-es.1` / `7a99c3ebae8ed6f264d71afab3ef1b2a52f45376` |
| Protocol input | #244 / `1097faddff7df3c4786bab592d22dd4b952b5d0a` |
| Planned runtime | `evaos-runtime-es.12-v0.21.0-r31.1` |
| Planned ARM64 Mac | `v2026.9.5-es.1`, bundle `com.electricsheephq.evaos.agent` |
| External LCM | v0.20.0 / `49e99a272d2d461e5c90732e7ef2bc20e96f0826` |
| PCS input | `0594fe09a1d623dd016a2d880e9e25554c03f9d3`; dependency PCS #799, candidate PR must stay unmerged |
| Operator source | `e3f12986e389d8a84c17639b32098e2366120537`; re-read normal update runbook before execution |

The final fork head, merge/tree SHA, artifact digests, manifest candidate SHA, CI/review links and internal receipts are execution outputs. Do not publish placeholders as proof or change the upstream pin on drift.

## Required compatibility

The [managed-delta ledger](../r31-managed-delta.md) records port commits and focused RED/GREEN receipts. Final PR checks and selected reviewers must bind one frozen head; local checks do not waive remote CI. The approved upstream pin and both predecessor inputs are unchanged.

Four pairings: current/current, new-runtime/current-Mac, current-runtime/new-Mac, new/new. Legacy protocol1, current2 and new3 must expose and dispatch only supported GUI actions. Missing/invalid/future values and aliases/direct calls receive the same safe treatment. Non-Desktop/background/cross-owner GUI requests do not reach another session's surface.

Disposable old/new stores prove new writes/restart and predecessor read/append, including old FTS-v1 and candidate-created databases. Preserve managed profile selection and existing config values. Load pinned LCM before/after September14 with deprecated imports disabled and prove context/native-tool calls. No optimize-storage, rebuild, conversion or live-store export.

Managed parity includes protected config, credential provenance and writeback, MCP lease/cache, restart/search isolation, encrypted enrollment, callback/relay, media and additive composer persistence. Astra fixtures prove catalog/routing only, not provider entitlement.

## Release gates

- Focused behavioral tests, canonical exact-source CI/security and terminal current review findings.
- Two blind implementation checkers: acceptance and adversarial, each PASS ≥95 on stable source; same pair for targeted changed-head corrections.
- Live exact-head merge barrier and reconciled actual merged tree.
- Immutable runtime artifact before dependent existing-format PCS manifest pins; no provisioning/default/Golden promotion.
- Repository-owned ARM64 signing/notarization/stapling, exact logical profile and unchanged bundle/team. Verify ZIP, DMG, both blockmaps and latest-mac.yml against source stamp, signatures/Gatekeeper and hashes. No untracked dependency patches or overwritten published bytes.
- Runtime release remains distinct from Desktop GitHub latest.

## Internal update and Mac promotion

Resolve one existing authorized internal assignment and its actual deployed r30.7 predecessor. Normal exact-commit package installer preserves current user, service, installation path and HERMES_HOME. Continue a pre-existing synthetic conversation on the current Mac before testing the new signed Mac.

The signed Mac must preserve existing encrypted login and assignment, quit normally with predecessor processes exited, survive a cold restart, then complete:

`desktop_preview(open, https://example.com) → desktop_preview(read) → drive_preview(elements) → desktop_preview(close)`

Observe the local pane, Example Domain content, public link inventory, and exactly one response per request within five seconds. Open dispatch is not rendering proof. Do not click the public link or use customer content. Stop at password/MFA.

Only after prepublication gates pass, promote the complete Mac release. Restore the verified Mac predecessor locally, exercise its actual in-app updater into published bytes, then repeat cold-restart/persistence/Preview acceptance. Retain the passing pair and rollback artifacts. #242 stays open for employee acceptance.

## Recovery and budgets

Three prepublication internal install-test cycles and one postpublication actual updater transaction. A failed installed attempt requires immediate affected-predecessor restoration, with data left in place. A distinct evidence-backed retry must remain within the unused budget. On public Mac acceptance failure, restore local predecessor and previous latest, mark the failed release prerelease and preserve immutable assets. This stops new offers; it does not automatically downgrade installed updates.

Re-read exact sources, artifact/assignment identities, gates, authority and budget before integration, review, merge, manifest pinning, installation, signing/notarization, publication, rollback and closeout. The current public release remains latest until the specified internal gates pass.

## Claim boundary

No source confidence yet. Passing local/CI tests is not a release, and one internal installed/update receipt is not employee/fleet/customer success. Customer rollout, #243 loopback proxy, #124 broad audit, Golden/default promotion and arbitrary Mac control remain outside the release.
