# ADR 010: Multi-device Herdr runtime

Status: accepted; startup and recovery policy extended by
[ADR 015](015-connection-recovery.md).

[Decision index](README.md) | [Current architecture](../architecture.md)

## Context

The earlier client kept one selected runtime even though native SSH sessions
could coexist. Switching devices replaced the bridge and refetched state.
Counting agents on other hosts required a second SSH/Python path that duplicated
Herdr protocol handling.

## Decision

Retain a `HerdrBridgeTransport` and runtime per device. Expose the selected
device's runtime as derived state. Route agent actions through the owning
device, indexed from snapshots because agent IDs are hashes.

Derive agent counts from those runtimes instead of maintaining a separate
counting transport.

## Consequences

One device can fail while another remains usable. Pure repository selection
does not perform I/O; an explicit connect action may select and enable a host.
Automatic recovery must not change selection.

The root supervisor now manages eligible hosts and recovery. It replaces the
earlier eager tab-shell connection trigger. Resource usage grows with enabled
hosts; no LRU connection cap is currently implemented.

Herdr events update runtime snapshots. Conversation reads are coalesced, and
the focused foreground chat uses bounded polling. Exact cadence and background
policy are in the [rendering](../markdown-rendering.md) and
[recovery](../connection-resilience.md) guides.

## Rules

- Use the ownership index; do not parse a device from an agent ID.
- Keep device failures and connection attempts isolated.
- Keep selection separate from recovery policy.
- Do not add another independent Herdr-state transport for counts or badges.
