# ADR 007: Known hosts and secrets

Status: accepted; implements and supersedes the initial plan in
[ADR 004](004-secure-credential-storage.md).

[Decision index](README.md) | [Current security guide](../security.md)

## Decision

Persist SSH fingerprints after explicit user verification. Never silently
replace a mismatched key. Store saved credentials in Android
`EncryptedSharedPreferences` with a Keystore-backed master key, referenced
from host metadata by `credentialId`.

## Consequences

Unknown or changed host keys stop the operation. The interactive connection
flow supports fingerprint verification; background recovery does not
automatically accept a key or continually retry bad credentials.

[`KnownHostsStore.kt`](../../modules/remote-core/android/src/main/java/com/remoteworkspace/remotecore/KnownHostsStore.kt)
stores hostname/port/fingerprint records separately from
[`SecretStore.kt`](../../modules/remote-core/android/src/main/java/com/remoteworkspace/remotecore/SecretStore.kt).
Jump-host forwarding must retain the intended host identity for verification.

These choices protect authentication material. They do not encrypt
AsyncStorage drafts, command payloads, or cached conversation text.

## Rules

- Never accept all server keys or auto-replace a mismatch.
- Never log decrypted credentials or full connection request objects.
- Preserve storage/application identities during a branding-only rename.
- Treat trust/authentication failures as actionable failures, not transient
  network outages.
