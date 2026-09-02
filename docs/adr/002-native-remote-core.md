# ADR 002: Native remote core

## Context

SSH, SFTP, tunnels, and credentials need a mature native implementation.

## Decision

Own those concerns in a Kotlin `remote-core` module behind typed TypeScript interfaces. Use a library such as SSHJ. Do not invent cryptography.

## Reasons

React Native should call `RemoteClient`, not sockets or ciphers.

## Consequences

Phase 1 defines the boundary but does not implement the module.

## Rules

Do not scatter SSHJ calls through feature UI. Implement only what the current milestone needs.
