# ADR 008: Herdr mobile bridge

Status: accepted; extended by [010](010-multi-device-herdr-runtime.md) and
[015](015-connection-recovery.md).

[Decision index](README.md) | [Current integration](../herdr-mobile-architecture.md)

## Context

The Android app needs semantic conversations for Herdr-managed coding agents
without adding a public Herdr endpoint or a mobile terminal.

## Decision

Bundle a standard-library Python bridge, deploy it through SFTP, and launch it
through a non-PTY SSH exec channel. Use protocol-versioned NDJSON on
stdin/stdout while Herdr remains accessible through its local Unix socket.

Herdr supplies runtime identity/status. Provider adapters supply semantic
conversation items when their transcript format can be decoded. Otherwise,
return an explicit `agent.read` compatibility view.

## Consequences

Android and product UI depend on normalized models rather than raw Herdr
schemas. Native code owns channel lifetime and request deadlines.

The current deployment uses verified content-addressed files under
`~/.local/share/remote-workspace/`, not a mutable script guarded only by a
separate checksum. Durable commands and handshake readiness are specified in
the [bridge contract](../../modules/remote-core/bridge/README.md).

## Rules

- Do not allocate a PTY or expose a generic shell action in the bridge.
- Keep diagnostics off stdout.
- Do not infer semantic messages from raw terminal output.
- Disconnecting the mobile client must not stop Herdr or its agents.
- Preserve journal history across bridge upgrades and reconnects.
