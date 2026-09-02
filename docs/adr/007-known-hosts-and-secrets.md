# ADR 007: Known hosts and secrets

## Context

SSH host keys must be verified. Passwords and private keys must not be stored in plaintext.

## Decision

Persist host fingerprints after explicit user trust. Never auto-replace a mismatched key. Store secrets in EncryptedSharedPreferences backed by Android Keystore.

## Reasons

Silent trust hides MITM. AsyncStorage is not a credential store.

## Consequences

First connection shows a fingerprint dialog. Saved secrets are referenced from host metadata by `credentialId` only.

## Rules

Do not log secrets. Do not implement `setServerKeyVerifier { _, _, _ -> true }`.
