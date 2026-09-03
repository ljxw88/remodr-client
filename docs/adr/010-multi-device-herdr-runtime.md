# ADR 010: Multi-device Herdr runtime

Supersedes the implicit single-runtime assumption in
[ADR 008](008-herdr-mobile-bridge.md).

## Context

Selecting a different device tears down the active bridge and rebuilds the
runtime from scratch: stop the remote process, redeploy and relaunch the
bridge, wait for the Herdr subscription to acknowledge, then fetch a full
`runtime.snapshot`. Switching back to a device used seconds earlier repeats the
whole sequence.

Every layer below TypeScript is already multi-device. `SessionManager` keeps a
`ConcurrentHashMap` of bridges and only replaces bridges belonging to the same
SSH session, so bridges for different devices coexist. Each bridge process is
launched with `REMOTE_WORKSPACE_DEVICE_ID` and stamps `deviceId` on every
payload. Saved hosts already open their SSH sessions in parallel at launch.

Only `HerdrBridgeTransport` and `HerdrRepository` are single-tenant: one
`bridgeId`, one `runtime`, one `sessionId`. The application therefore pays for
N SSH connections and discards N-1 bridges.

That single runtime forced a second, parallel data path. Because only the
selected device has a live bridge, agent counts for other devices are collected
by executing an inline Python script over SSH that opens the Herdr socket and
calls `session.snapshot` directly, re-implementing part of the bridge protocol,
plus version counters in the repository to stop the two sources overwriting
each other.

## Decision

Hold one bridge transport and one runtime per device, keyed by device ID, for
every device with a live SSH session. Start them eagerly alongside the existing
saved-host auto-connect.

Selecting a device becomes pure view state and performs no I/O.

Expose the selected device's runtime and connection as derived fields so
screens continue to read one runtime.

Route agent-scoped requests through the transport that owns the agent, resolved
by an index built from runtime snapshots. Agent IDs are SHA-256 hashes of
session, device, and pane, so the device cannot be recovered from the ID.

Derive per-device agent counts from live runtimes and delete the SSH-exec
counting path.

## Reasons

- The native layer already supports this; only two classes prevent it.
- Switching devices becomes instant and preserves each device's state.
- One authoritative source for agent counts removes the version-reconciliation
  machinery and the duplicated protocol logic.
- Per-device connection state lets one device fail without blanking the others.

## Consequences

One bridge process runs per connected server rather than one in total. Bridges
block on the Herdr event socket rather than polling, and the one-second
conversation refresh applies only to the visible agent, so idle devices stay
cheap.

The runtime cache becomes per device. A single cache key would otherwise be
last-device-wins and can show one device's agents while another is selected.

Memory grows with the number of connected devices. Beyond a handful of saved
hosts, live bridges need an LRU cap.

## Rules

- Never route an agent request through a transport that does not own the agent.
- Never derive a device from an agent ID by parsing; use the index.
- Keep device selection free of I/O.
- Keep per-device failures isolated; one unreachable device must not change
  another device's connection state.
- Do not reintroduce a second path for reading Herdr state outside the bridge.
