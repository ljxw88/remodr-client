# Security and persisted data

[Documentation index](README.md)

## Credentials and host trust

[`SecretStore.kt`](../modules/remote-core/android/src/main/java/com/remoteworkspace/remotecore/SecretStore.kt)
uses Android Keystore-backed `EncryptedSharedPreferences`. Saved host records
contain a `credentialId`, not the password or private key. Credentials may also
be supplied for a connection without saving them.

[`KnownHostsStore.kt`](../modules/remote-core/android/src/main/java/com/remoteworkspace/remotecore/KnownHostsStore.kt)
stores hostname, port, and fingerprint in app-private `known_hosts.json`.
An unknown key requires explicit verification in the connection flow. A
mismatched key is never silently accepted or automatically replaced.
Jump-host verification uses the intended host identity rather than the
temporary loopback forwarding endpoint.

The supervisor stops automatic recovery on trust/authentication failures.
Network retries must not change those decisions. See
[ADR 007](adr/007-known-hosts-and-secrets.md).

## Storage boundaries

| Data | Storage | Protection and limitations |
| --- | --- | --- |
| Saved credentials | Native encrypted preferences | Keystore-backed; never copy into AsyncStorage or logs |
| Host profiles and settings | AsyncStorage | Unencrypted app-private data; may reveal hostnames, usernames, groups, and jump-host topology |
| Drafts, cached conversations, pending commands | AsyncStorage | Unencrypted message content; potentially sensitive even though it is not authentication data |
| Known host fingerprints | App-private JSON | Integrity is part of SSH trust; deleting entries requires re-verification |
| Remote command ledger | Private SQLite file under the remote user's deployment directory | Stores command fingerprints/results, not raw prompt payloads; preserves deduplication across bridge restarts |

Host schema validation excludes unknown fields; it does not make all metadata
non-sensitive. The complete allowed metadata shape is
[`HostProfile`](../src/domain/hosts.ts), including credential references and
jump-host IDs.

Do not log secrets, full connection option objects, raw prompts, or full bridge
requests. Select safe diagnostic fields explicitly and review logs and
screenshots before sharing them.

## Remote execution boundary

The bridge travels over authenticated SSH and contacts Herdr through a Unix
socket. It exposes named application actions rather than a generic shell
endpoint. Verified content-addressed deployment avoids executing partial uploads.

This is not a sandbox for provider tools. The provider CLI executes with the
remote user's privileges. The New Agent sheet's **Allow tools automatically**
option can pass provider-specific permission-bypass flags; do not promise that
the mobile app confirms every destructive tool action.

App-level confirmations for deleting a saved server or closing an agent/space
are separate from provider tool approval.

### Copilot workspace trust

Starting Copilot in a workspace selected through Remodr remembers that exact
canonical project directory in Copilot's `trustedFolders` configuration. This
is equivalent to trusting that folder for future Copilot sessions; only choose
projects whose contents and local instructions you trust. Automatic trust of
the filesystem root is refused. The configuration location follows
`COPILOT_HOME`, or defaults to `~/.copilot/config.json`.

Trust updates preserve other configuration fields and JSONC comments, serialize bridge writers,
check for external edits and publish privately with an atomic rename.
Malformed or unsafe configuration is reported rather than overwritten.
Workspace trust does not change the separate tool-permission toggle, SSH host
key verification, or unrestricted-path access. Arbitrary terminal approval
dialogs are never automatically answered.

If a bridge reconnect has lost an agent's launch-permission setting, a
Copilot restart defaults to tool prompts rather than granting tool bypass.
Avoid simultaneously editing Copilot configuration while launching agents:
Copilot's own writers do not share the bridge lock, so the external-edit
check cannot provide a cross-process atomic merge.

## Delivery and recovery safety

Durable send/answer commands bind their IDs to payload and session identity.
If dispatch may have occurred without a recorded outcome, the client reports
uncertainty instead of automatically repeating the operation. Interrupts remain
live-only in the client.

The journal validates ownership/permissions and fails closed on unsafe or
unavailable storage. Do not delete its database or initialization marker as a
retry workaround. Exact paths, limits, and recovery errors are in the
[bridge contract](../modules/remote-core/bridge/README.md); client behavior is
in [connection resilience](connection-resilience.md).
