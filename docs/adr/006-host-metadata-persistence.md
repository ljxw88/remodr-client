# ADR 006: Host metadata persistence

## Context

Phase 1 needs saved hosts that survive restart, without credentials.

## Decision

Store a versioned JSON document of `HostProfile` records through a `HostRepository`. The current adapter is AsyncStorage.

## Reasons

A repository hides storage so SQLite or files can replace AsyncStorage later. Zod validates reads and writes and drops unknown secret-like fields.

## Consequences

Host lists are local-only. Storage is unencrypted, which is acceptable because no secrets are written.

## Rules

Do not persist passwords, keys, or tokens. Keep writes limited to the host metadata schema.
