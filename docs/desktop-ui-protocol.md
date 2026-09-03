# Desktop UI protocol

The Desktop renderer and the Hermes runtime can update independently. Desktop
sessions therefore declare the highest renderer protocol they implement on
`session.create`, `session.resume`, and `session.activate`:

```json
{
  "source": "desktop",
  "desktop_ui_protocol": 2
}
```

The field is optional and additive. An older runtime ignores it. A current
runtime treats a missing, non-integer, Boolean, or otherwise invalid value from
a Desktop client as protocol 1. Values above the current protocol are clamped
to the highest level the runtime understands. A non-Desktop session always
negotiates protocol 0, regardless of the marker.

The marker is capability metadata, not authorization. `source: "desktop"`
remains mandatory for Desktop-only schemas and every live renderer request is
checked again against the owning session before an event is emitted or a
blocking wait begins.

## Capability levels

Protocol 1 is the compatibility surface implemented by legacy managed Desktop
builds:

- `read_terminal`
- `close_terminal`
- `open_preview`
- `focus_pane`
- `react_to_message`

Protocol 2 adds renderer responders introduced with the upstream 2026.8.27
Desktop:

- `close_preview`
- `read_preview`
- `drive_preview`
- `annotate_preview`
- `read_window_below`
- `setup_mcp`
- `tour`
- `apply_layout`

New and cold-resumed agents snapshot only the toolsets allowed by the negotiated
level. Live agents already have immutable schemas for prompt-cache safety, so
resume/activate also rebind the session-level guard. If a legacy client attaches
to a warm protocol-2 agent, a protocol-2 call returns
`desktop_ui_protocol_upgrade_required` immediately instead of waiting for a
renderer response that cannot arrive. A newer client attaching to a warm
protocol-1 agent gets the protocol-1 schema until it starts a new session.

`open_preview` remains fire-and-forget to match upstream. A successful result
means the event was dispatched; it does not prove that navigation rendered.
Call `read_preview` when rendered-page proof is required.

## Logging and privacy

Debug lifecycle logs contain only the tool name, outcome (`dispatched`,
`responded`, `expired`, `protocol_blocked`, or `error`), required and negotiated
levels, elapsed milliseconds, and a one-way truncated hash of the live session
id. They never include URLs, DOM text, prompts, identities, tokens, request
payloads, or file contents.

## Rollout order

Deploying the runtime guard before protocol-2 Desktop clients is safe: missing
markers default to protocol 1. Deploying a protocol-2 Desktop against an older
runtime is also safe because JSON-RPC ignores unknown request fields. Runtime
and Desktop release evidence remain separate.

Managed VM loopback URLs are a separate transport problem. They need an
authenticated port proxy; they do not require a GUI on the VM and are outside
this protocol.
