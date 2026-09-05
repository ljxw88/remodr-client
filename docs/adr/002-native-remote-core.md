# ADR 002: Native remote core

Status: accepted; implemented.

[Decision index](README.md) | [Current architecture](../architecture.md)

## Context

SSH, SFTP, port forwards, and credential handling need a native implementation
behind a typed application API.

## Decision

Own those resources in the local Kotlin
[`remote-core` module](../../modules/remote-core/), using SSHJ rather than
implementing an SSH protocol or cryptography layer in JavaScript.

## Consequences

This is no longer a placeholder boundary. The module owns authenticated SSH
clients, jump chains, bridge channels, file operations, local forwards, known
hosts, encrypted secrets, and the foreground service.

The TypeScript supervisor owns recovery policy; native code owns resource
lifetime and fences obsolete connection attempts. Typed errors cross the Expo
boundary. See [connection resilience](../connection-resilience.md) for lifecycle
details and [security](../security.md) for trust/storage requirements.

UI code calls the typed client or feature services, not SSHJ or raw sockets.
