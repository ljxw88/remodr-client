# ADR 004: Initial credential-storage boundary

Status: superseded by [ADR 007](007-known-hosts-and-secrets.md).

[Decision index](README.md) | [Current security guide](../security.md)

## Context

The initial host-management phase needed saved metadata before implementing
login and native secret storage.

## Decision at that stage

Keep credentials out of host JSON. Plan for Keystore-backed storage referenced
by an opaque credential ID rather than storing passwords or private keys with
the host record.

## Subsequent implementation

Login and encrypted secret storage now exist. ADR 007 selects
`EncryptedSharedPreferences` backed by Android Keystore and persistent SSH host
verification. The original statement that login secrets were out of scope
applied only to the initial phase.

The boundary remains: metadata stores and conversation caches are not
credential stores. Never commit or log decrypted credentials.
