# ADR 004: Secure credential storage

## Context

Passwords, keys, passphrases, and API tokens cannot live in plaintext app storage.

## Decision

Persist host metadata without secrets. Future secrets use Android Keystore-backed encryption and are referenced by id.

## Reasons

AsyncStorage, SQLite, and JSON files are not credential stores.

## Consequences

Phase 1 has an auth-type placeholder only. Login secrets are out of scope.

## Rules

Never commit secrets. Never log decrypted credentials.
