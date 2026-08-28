# The "Pipedream WORKING" gate — layered evals + the iteration ladder

**THIS REPO is where the gate bites: no release (r-tag) touching the Pipedream/MCP path may be cut
above a red layer.** Eval fixtures/runners live in evaos-provisioning-customer-scripts; the doc is
canonical HERE because the client code and the release train are here.

**Why this exists:** twelve releases (r1–r12) shipped Pipedream "fixes" without one end-to-end
probe against production; the contract gap sat in a single unverified sentence (adapter PR#90)
until 2026-08-13. This document is the durable gate so that can never recur. It encodes the
release-follows-proof ladder that fixed it (receipts: support-control#546, 2026-08-13).

**The rule: no layer's fix ships until the layer below is green in PRODUCTION with a receipt.**
Failures isolate by layer — start every debug at Layer 0, never at the top.

## Layer 0 — contract probe (~10 s, from any customer box; would have caught r1–r12)
```bash
EP="https://<SUPABASE_PROJECT_REF>.supabase.co/functions/v1/desktop-runtime-session"
SEC=$(cat /etc/evaos/hermes/pipedream-broker-secret)
# per-profile identity from the profile's managed entry:
#   /etc/evaos/hermes/managed/<profile>/config.yaml → mcp_servers.evaos-pipedream-<app>
#   fields: external_user_id + account_id
curl -s -w " HTTP %{http_code}\n" -X POST "$EP" -H "Content-Type: application/json" \
  -H "X-Evaos-Desktop-Broker-Secret: $SEC" \
  -d '{"action":"pipedream_mcp_lease","app_slug":"<app>","external_user_id":"<eu>","account_id":"<apn_...>"}'
```
GREEN = HTTP 200, response headers echo the identity, `expires_at` ~1 h out.
Also assert the fences: no identity + no grant header → 401 "Pipedream MCP grant is required";
identity + grant header together → 400 "cannot mix". Any other shape = the deployed fn drifted —
fix the FN (or the client contract) before touching anything above.

## Layer 1 — transport probe (~1 min, same box): raw MCP round-trip on the minted lease
POST JSON-RPC to the returned `mcp_url` with the returned headers: `initialize` →
`notifications/initialized` → `tools/list` (expect the app's native tools) → one READ tool call
(e.g. `activecampaign-get-all-lists`) → REAL data back. GREEN = real payload. Red here with
Layer 0 green = Pipedream-side or lease-header handling — not our fn, not our box config.

## Layer 2 — automated canaries (nightly, already installed)
- `@louis` native-pipedream smoke on jackie-david (`/etc/evaos/native-pipedream-smoke/louis.prompt`, 02:30 UTC)
- `@operations` smoke on eric-wilder (same time) — ⚠ appends to a live customer Telegram session
GREEN = marker-gated pass. These went RED 2026-08-11/12 with the lease-contract failure and are
the standing regression tripwire. Red here with Layers 0–1 green = per-profile gateway state
(identity seeding, env, unit) — check the profile's managed entry carries the two identity fields.

## Layer 3 — real-workflow evidence (the only source of customer-facing claims)
- David/jane: `evaos-provisioning-customer-scripts scripts/eval/fixtures/dorman-workflow-matrix.v1.yaml` (14 cells; provenance
  `evaos-provisioning-customer-scripts docs/eval-provenance/jane-dorman-workflows.md`, mined from 935 real turns). Runner:
  `cd /root/evaos-eval/staging/<run-id>/scripts && python3 eval/run_customer_matrix.py \
   --fixture <filled fixture> --allowlist <allowlist> \
   --output-dir /var/lib/evaos/eval/<suite>/<run-id>/evidence` (filled fixtures live on-box only,
  never committed).
- Eric/Chris: `evaos-provisioning-customer-scripts scripts/eval/fixtures/wilder-workflow-matrix.v1.yaml` (16 cells; provenance
  `evaos-provisioning-customer-scripts docs/eval-provenance/eric-wilder-workflows.md`, mined from 10,890 OpenClaw transcripts).
Baseline for comparison: jane 2026-08-12 06:39Z = 5P/3F/6INC (writes OFF), preserved in
session-notes 2026-08-13 real-workflow-evals + published on support-control#546.
Red here with Layers 0–2 green = AGENT behavior, not plumbing — grade against the 3 axes
(artifact correctness · sequencing · honest failure), never "fix" by weakening a cell.

### Protected evidence contract

- `/root/evaos-eval/staging/<run-id>` is disposable staging. It may hold the task-local runner,
  fixture, allowlist, and raw process streams while the run is active.
- `/var/lib/evaos/eval/<suite>/<run-id>/evidence` is persistent evidence. Retain eval JSON,
  redacted stdout/stderr, and a SHA-256 manifest there. Delete raw process streams after the
  redacted copies and manifest are complete.
- Session cleanup removes only the eval session rows. Routine task cleanup removes only the
  exact staging directory. It must not remove persistent evidence. Evidence removal is a later,
  separate exact-target action, after the protected local copy and aggregate receipt are accepted.
- `tool_errors` is the bounded diagnostic source: each entry keeps the tool, category, exposed or
  inferred HTTP/PostgREST code, bounded redacted message, truncation state, and SHA-256 of the
  full redacted message. Logs may contain only a shorter preview.
- Read both sides of the run window: eval evidence plus `agent.log`, `errors.log`, and the serving
  unit journal. In a shared multiplex process, a requested profile's activity may be written to
  the launch/default profile's log directory. Correlate by session and time; absence from the
  requested profile's directory is not proof that the turn did not run.
- Evidence and shareable receipts must not contain raw secrets, addresses, identifiers, prompts,
  transcripts, configs, or provider payloads. Loopback evidence diagnoses only the named runtime
  path; it does not prove ordinary chat behavior, workflow parity, or customer readiness.

## Layer 4 — the human surface
One real end-user turn (Telegram, the actual profile) exercising a connector. This is what
`customer_proven` means — nothing below it may use that phrase (see the lane-contract /
gate-closeout claim classes on the program board).

## THE GATE
"Pipedream working" closes when: Layers 0–2 green + the workflow matrices' connector-dependent
cells free of transport-class INCONCLUSIVEs, **3 consecutive on-demand runs, same-day repeatable**
(owner cadence ruling 2026-08-13 — never nightly accrual), + at least one Layer-4 receipt per box.
Score lives on the program board (support-control#544 / gate #546) — never in prose from memory.

## Standing invariants (each earned the hard way)
- The lease client sends identity from the profile's own managed entry (both-or-neither); the
  grant-header path is deployed back-compat ONLY — never re-add grant machinery client-side.
- New app connected ⇒ the connect pipeline writes the entry and converges the affected runtime
  consumer through the reviewed PCS reconciler (pcs#565). The normal product path verifies the
  resulting route set; it does not tell the customer to run `/reload-mcp`, start `/new`, hand-seed
  config, or wait for cache expiry. `/reload-mcp` remains the human recovery/debug path. On a
  per-profile gateway it reloads that profile. On an r28 shared multiplex gateway it resolves the
  routed event's profile home, shuts down and rediscovers only that profile's MCP registry, refreshes
  only cached sessions in that profile namespace, and reports both eager and lazy available routes
  without opening cached lazy routes. A lazy route with no valid schema cache may connect once during
  bootstrap to populate that cache; this is discovery, not permission to expose it across profiles.
  Sibling profiles remain untouched. The programmatic
  `reload.mcp` JSON-RPC method on the serve RPC surface is revision-aware and refreshes the exact
  session after a confirmed reload; it is not an HTTP endpoint. Both interactive forms may invalidate
  the prompt cache and therefore retain the approval/confirmation gate. Layer-1 lesson
  (eric-wilder, 2026-08-13): seeding + reload made servers MOUNT per-profile
  (principal header resolves the overlay) yet tools stayed unreachable at turn time — L0-green
  via curl does NOT imply the SERVING PROCESS can mint (check the unit's credential delivery:
  jackie-david's per-profile units carry the broker secret via a LoadCredential drop-in; a serve
  unit without it fails exactly this way). Verify the serving process's credential context, not
  just the files on disk.
- Token re-mints are connection-invisible (pre-refresh 60 s before expiry); a "transport is down"
  error is NEVER about token expiry — start at Layer 0.
- Client 401s were historically mislabeled "broker secret was rejected" (adapter#100) — read the
  SERVER body via the Layer-0 curl before believing any client error string.
