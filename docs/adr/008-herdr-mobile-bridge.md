# ADR 008: Herdr mobile bridge

## Context

The Android application needs a chatbot-like interface for coding agents
managed by Herdr without exposing Herdr or terminal controls over the network.

## Decision

Bundle a standard-library Python bridge and deploy it through the existing SFTP
channel to `~/.local/share/remote-workspace/`. Launch it through a non-PTY SSH
exec channel. Use versioned NDJSON on stdin/stdout and keep Herdr on its local
Unix socket.

Herdr protocol 20 supplies runtime identity and status. Provider adapters
supply semantic conversation items. GitHub Copilot uses its structured
`events.jsonl`; unsupported/unavailable adapters fall back conservatively to
`agent.read`.

## Reasons

- SSH remains the only network boundary.
- Android does not depend on Herdr's raw schema.
- Existing agents survive mobile disconnects.
- Provider failures remain isolated.

## Consequences

The native module owns bridge process and request timeouts. React Native sees
only normalized agents, conversations, tools, requests, and runtime state.

## Rules

- Never allocate a PTY for the bridge.
- Never expose a generic shell action in the bridge protocol.
- Never print diagnostics to bridge stdout.
- Never infer semantic messages when only terminal output is available.
- Never stop Herdr or an agent when the mobile client disconnects.
