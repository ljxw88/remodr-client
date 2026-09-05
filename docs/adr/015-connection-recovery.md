# ADR 015: Supervised recovery and durable commands

Status: accepted; implemented.

[Decision index](README.md) | [Current recovery guide](../connection-resilience.md)

## Context

Mobile connections can disappear during network changes, backgrounding, or
process loss. Herdr already owns the remote agents independently of the phone,
but a client that discards input or requires repeated manual retries cannot
make use of that persistence.

Blindly retrying a timed-out send risks executing it twice.

## Decision

Keep SSH-exec transport and add a per-device connection supervisor, durable
local outbox, and private persistent command ledger in the bridge. Reconnect
by fetching authoritative snapshots instead of requiring durable event replay.

Use separate command IDs and wire-attempt IDs. Bind durable mutations to their
target identity and preserve outcomes across bridge restarts. Report the
dispatch/ledger crash gap as uncertainty rather than claiming exactly-once
execution.

Add an Android `dataSync` foreground service for eligible active work, while
retaining recovery when the service is denied, stopped, or timed out.

## Consequences

Transient failures trigger automatic recovery and a floating status indicator.
Reconnect controls open in a bottom sheet without resizing the page. Cached
transcripts and locally saved commands remain visible. Authentication, host
trust, invalid targets, and uncertain delivery require explicit attention.

Native per-host/per-session attempt ownership complements TypeScript recovery.
Bridge deployment uses verified versioned files so partial concurrent uploads
cannot become a persistent reconnect failure.

No Mosh/ET transport, persistent bridge daemon, or `since_seq` event-log
protocol is introduced. Provider token streaming is also a separate concern.

## Rules

- Keep retry policy in one supervisor and honor explicit disconnect.
- Never replace a logical command ID just because an ACK was lost.
- Do not automatically queue/replay an interrupt into a later run.
- Keep blocking remote operations outside native publication locks.
- Preserve journal history through deployment and reconnect.
- Treat foreground service and Doze behavior as OS-constrained, not as a
  guarantee of continuous execution.
