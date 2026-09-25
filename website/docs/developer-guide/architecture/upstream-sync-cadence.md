# Decision record: upstream-sync cadence for the paired runtime + Desktop fork

Status: accepted (owner decision 2026-09-08; amended 2026-09-13 — see the amendment below). Source of record: https://github.com/electricsheephq/evaOS-hermes-desktop-app-adapter/issues/272

Related:
- [ADR: paired pinned-main updates without migration](r31-paired-pinned-main.md)
- [r31.1 release and compatibility packet](../releases/r31-paired-release.md)
- [r31.1 managed-delta ledger](../r31-managed-delta.md)

## Context
Owner decision 2026-09-08 (evaos-support-control#890 program): customers run **our latest release**, and Desktop (this repo's [apps/desktop](../../apps/desktop)) and the runtime (this hermes-agent fork) are kept **in sync commit-wise with upstream `NousResearch/hermes-agent` plus our managed delta**. The existing ADR [docs/architecture/r31-paired-pinned-main.md](r31-paired-pinned-main.md) (accepted) already defines HOW one paired update is executed — one reviewed fork tree, upstream pinned to an immutable commit, managed behaviour ported into it ([docs/r31-managed-delta.md](../r31-managed-delta.md) ledger), gates in [docs/releases/r31-paired-release.md](../releases/r31-paired-release.md). This record defines **WHEN**, plus the between-pin patch rule and the release-feed policy. It does not change the ADR.

## Decision
1. **Cadence.** One paired upstream re-pin per **two weeks, or on each upstream tagged release** (e.g. v0.21.x → v0.22.0), whichever comes first. Never re-pin mid-cycle ("do not change the upstream pin on drift" stands). The pin target is upstream's latest **tagged release commit**, not moving main; a main-only commit is allowed only for a needed fix, with the reason recorded in the ledger.
2. **One tree, one paired set per cycle.** Runtime tag `evaos-runtime-es.<D>-v<upstream>-r<N>.<M>` (GitHub prerelease by the latest-guard rule; the PCS manifest pin follows only after the artifact is immutable) + Desktop `v<date>-es.<K>` (full release). The managed-delta ledger is updated per cycle: which fork commits were re-ported and their RED/GREEN receipts.
3. **Between pins.** Desktop patch releases (es.5-style) and runtime point releases (r31.3-style) are allowed **without** re-pinning: they branch from the current pinned tree, carry small verified fixes only, pass the same signing/notarization/gates, and ship as a full Desktop release when customer-facing.
4. **Feed policy (owner 2026-09-08).** `releases/latest` flips with every full Desktop release after (a) notarized build, (b) internal install + drive on the orchestrator Mac, (c) once per cycle, an actual predecessor → published in-app updater transaction (paired-release step 6). Runtime tags never displace Desktop latest ([evaos-release-latest-guard.yml](../../.github/workflows/evaos-release-latest-guard.yml) unchanged). The dashboard download page must serve the same release (website-dashboard-electricsheephq#1043 removes the second pointer).
5. **Fleet convergence per cycle.** Canary order internal (Benjamin) → David → wave Holly → Tusker → Jackie → Eric → Matt via the box-rung with custodian + refuter; the cycle is DONE when `fleet_runtime_sha_variants = 1` on the new r-tag and the PCS pin is merged. Waves stay pre-authorised by the ratified Phase-2 plan (sc#892); a cycle that changes customer-visible behaviour (prompts, defaults, channels) gets an owner line before the first customer box.
6. **Stop rules.** Upstream changes that break the managed delta → the cycle pauses at the port step with a report (no partial pin). A failed canary → hold: no feed flip, no PCS pin, predecessor restored per the ADR.
7. **Ownership.** Orchestrator lanes (Codex implementer, cross-model review, independent refuter) run the cycle; the human gate remains only for changing/cutting over live customer agents outside the ratified plan.

## Amendment 2026-09-13 (owner decision)

Status: accepted (owner, chat 2026-09-13; acknowledged on evaos-support-control#883, comment 5651695597). Applies from the r32.0 → r33.0 cycle onward. Amends rules 1, 3 and the cadence clock; every other rule stands.

1. **Pin target = upstream tagged releases only.** The paired pin is always an upstream release tag (`vYYYY.M.D`, Hermes `0.x.y`). A main-only upstream commit is never a pin target, not even for a needed fix (this supersedes the rule-1 exception). Upstream's post-tag main is read for risk sizing only.
2. **Temporary patch release between pins only for a critical fix.** Critical means a security defect or a customer-breaking defect. Procedure: cherry-pick the fix onto the CURRENT pinned tree → runtime tag `r<N>.<M+1>` (plus a Desktop patch release when the fix is customer-visible) → PCS point label → owner line on evaos-support-control#883 → canary on the internal box when it runs that pin, otherwise on the sanctioned pilot (David) → every box on that line, one box per window, until `fleet_runtime_sha_variants = 1` holds again. Never a main re-pin. A box-specific config repair without a runtime change is outside this rule.
3. **Build in parallel, roll out after a stabilization hold.** A cycle's source qualification (fork pin PR, managed-delta ledger, two blind reviews, runtime tag, PCS pin PR, internal canary) starts while the previous cycle's customer rollout is still finishing. The customer rollout of the new cycle starts only after a stabilization hold of one to two weeks measured from the previous cycle's DONE (rule 5), decided by a go/no-go of binary checks posted on evaos-support-control#883: (a) pin, tag and PCS label merged; (b) internal canary soaked at least three days with zero unplanned unit restarts, zero tracebacks and producer `approved == observed`; (c) host maintenance (restart policy and kernel) complete fleet-wide; (d) no open P1 attributed to the running release; (e) known non-blockers listed explicitly. Any red check extends the hold; there is no partial rollout.
4. **Re-pin at the go/no-go.** When upstream has published a newer tagged release by the go/no-go and its paired port is clean (gates green, no rule-6 pause), that release becomes `r<N+1>.1` in the same cycle and only the three-day internal soak restarts; otherwise the soaked build rolls out unchanged.
5. **Clock.** Rule 1's "two weeks or each tagged release" becomes "next upstream tagged release available AND the hold elapsed". Cycles are paced by upstream tags and the hold, never by the calendar alone.

Rationale (owner): upstream is in a refactor phase; customers run stable tagged builds only, and each release gets a real soak before the next one moves.

## Left to the owner
- Renaming the Desktop train off `es.N` (website-dashboard-electricsheephq#793); if wanted, do it before the next full Desktop release so the download pointer moves once.
- Whether the runtime tag adopts the same numbering scheme.

## Next actions
- Docs: add this record as [docs/architecture/upstream-sync-cadence.md](upstream-sync-cadence.md) (mechanical PR, links back here).
- First cycle: the next upstream tag after v0.21.0, or 2026-09-22 at the latest.
- es.5 (adapter#91 items 13/14 + "degrade, don't lie") ships as a rule-3 patch on the current pin.
