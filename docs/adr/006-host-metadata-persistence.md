# ADR 006: Host metadata persistence

Status: accepted.

[Decision index](README.md) | [Current security guide](../security.md)

## Context

Saved hosts must survive app restarts without embedding credentials in their
metadata.

## Decision

Store a versioned JSON document through `HostRepository`. The implementation is
[`JsonHostRepository`](../../src/services/json-host-repository.ts) over
AsyncStorage. Zod schemas in [`hosts.ts`](../../src/domain/hosts.ts) validate
records and exclude unknown fields.

## Consequences

Metadata remains local and unencrypted. It includes endpoint and authentication
method information, an optional `credentialId`, grouping/favorite fields,
jump-host IDs, and timestamps. These fields can still be sensitive even though
they contain no password/private-key material.

Repository writes are serialized. Credential persistence and host trust are
separate native concerns defined by [ADR 007](007-known-hosts-and-secrets.md).
Connection-setting changes must also invalidate old connection attempts and
queued commands; see [ADR 015](015-connection-recovery.md).
