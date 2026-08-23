# The Pipedream WORKING gate

This repository owns the native Pipedream MCP client, so a release that changes
that path must pass the applicable layers below. Start at Layer 0 and advance in
order. A higher-layer failure does not authorize changes below a green layer.

## Layer 0 — lease contract

From the exact authorized test profile, mint a lease through the deployed evaOS
broker using the profile's managed `external_user_id` and `account_id`.

Green means:

- HTTP 200;
- the response identifies the requested route without fallback;
- expiry is approximately one hour away;
- missing identity is denied;
- mixed identity and legacy grant headers are denied.

Do not print or retain the broker secret, lease headers, connector identifiers,
or response payload. A red Layer 0 is a broker or identity-contract failure, not
an MCP transport failure.

## Layer 1 — native MCP transport

Use the official MCP SDK with the minted URL and headers:

1. `initialize`;
2. `notifications/initialized`;
3. `tools/list`;
4. one harmless read-only tool call.

Green means native tools and a real read result arrive through the exact route.
Evidence contains only redacted metadata and digests. A red Layer 1 with Layer 0
green belongs to the native MCP transport or lease-header path.

## Layer 2 — routed runtime canary

On the exact authorized canary only, prove the serving profile can discover and
use its route while a sibling profile cannot see or invoke it. Reload through the
supported profile-scoped path and prove sibling tool counts remain unchanged.

For r30, Layer 2 is Benjamin-only. Historical customer jobs are not release
canaries and must not be contacted or mutated by this program.

## Layer 3 — real workflow evidence

Run the repository-owned, redacted workflow fixture for the named target only
when the release plan explicitly requires it. Grade artifact correctness,
sequencing, and honest failure separately from transport health.

## Layer 4 — customer surface

One real end-user turn through the assigned profile and connector. Only this
layer can support a customer-facing behavior claim. It is not required for an
r30 source, package, or Benjamin `runtime_safe` claim.

## Release rule

The r30 source gate requires protected L0-L2 plus LP3: a real MCP 2.0/httpx2
client, a real minted non-customer lease, and one harmless read. Source tests do
not replace LP3. The final tag waits for a redacted receipt. Benjamin installation
and its 24-hour canary are separate runtime proof.

## Invariants

- Exact Pipedream account identity is authority; order, recency, labels, and
  email hints never select or authorize a route.
- The client sends the profile's own managed identity. Do not add client-side
  grant machinery, a proxy, or a second lease system.
- A per-profile r30 gateway reloads only that profile. `reload.mcp` is the
  programmatic RPC hook; `/reload-mcp` is the human chat path and may persist its
  confirmation setting.
- Verify the serving process has the broker credential context. A successful
  out-of-process curl does not prove the gateway can mint a lease.
- Lease refresh is connection-invisible. Diagnose transport errors from Layer 0
  upward rather than assuming token expiry.
- Never use a working customer connector for destructive lifecycle proof.
