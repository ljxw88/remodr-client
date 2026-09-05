# Connection recovery and message delivery

[Documentation index](README.md) | [Decision](adr/015-connection-recovery.md) |
[Bridge contract](../modules/remote-core/bridge/README.md)

## Ownership

Herdr owns remote panes and agents. Closing a mobile SSH attachment does not
intentionally terminate them, but a disconnected client cannot confirm the
server is still running.

`ConnectionSupervisor` owns recovery for each device. `connect-runtime.ts`
adapts it to saved hosts, SSH, and `HerdrRepository`. The root lifecycle hook
supplies network/app-state signals. Screens observe state; they do not start
their own retry timers.

| Source | Responsibility |
| --- | --- |
| [`connection-supervisor.ts`](../src/features/connection/connection-supervisor.ts) | Retry, probe deadlines, ownership, and lifecycle policy |
| [`connect-runtime.ts`](../src/features/agents/connect-runtime.ts) | Host/SSH/repository adapter and explicit connection preferences |
| [`use-connection-lifecycle.ts`](../src/features/connection/use-connection-lifecycle.ts) | Network/foreground signals and confirmed service activity |
| [`command-outbox.ts`](../src/services/command-outbox.ts) | Serialized local command persistence |
| [`herdr-repository.ts`](../src/services/herdr-repository.ts) | Snapshots, pending overlays, dispatch and reconciliation |
| [`connection-status.tsx`](../src/features/connection/connection-status.tsx) | Non-modal connection and message-delivery status |

Only explicit selection changes the selected device. Retrying one host cannot
move a conversation to another host. Explicit disconnect disables automatic
reconnection for that device, including across app restarts; explicit connect
enables it again. Deletion or changes to connection settings stop the old
connection and invalidate queued commands for the old endpoint.

Native connection publication is fenced by per-host and per-session attempt
generations as well. An obsolete connect or bridge startup can only close its
own resources, never a newer attachment.

Bridge deployment uses a verified, content-addressed launch file and a unique
staging upload. Atomic publication is used where supported; otherwise only the
fully verified private staging file is executed. The old shared checksum file
is not authoritative; native code verifies the installed contents before reuse.

## Detecting and recovering from a drop

- Native SSH keepalives require acknowledgements, rather than merely sending
  traffic. Bridge EOF is reported with a structured transport-closed event.
- Request timeout, transport closure, network failure, authentication, and host
  trust failures have distinct codes. Recovery never depends on matching
  English exception messages.
- The supervisor maintains one attempt per device, fences stale completions,
  and checks health while active. A successful bridge startup is not enough:
  synchronization must also reach Herdr.
- Automatic retry uses full jitter with a 500 ms base and 30 second cap. The
  initial retry is immediate; repeated failures retain their backoff.
- App foreground/network changes trigger a health check or retry. These signals
  do not bypass host-key checks or restart fatal authentication failures.
- Lack of public-internet reachability does not disable LAN/VPN SSH.
  `isConnected === false` pauses attempts; unknown reachability is not offline.

Connections can still fail during radio changes, Doze, OEM power management,
server restarts, or process death. Recovery preserves usable state where
storage is available; it does not keep every socket alive indefinitely.

Current timing defaults are implementation values, not network guarantees:

| Setting | Value | Owner |
| --- | --- | --- |
| Acknowledged SSH keepalive | 10 seconds, count 3 | `SshPolicy.kt` |
| Foreground/eligible-background health interval | 15 seconds | `connection-supervisor.ts` |
| Health-probe deadline | 10 seconds | `connection-supervisor.ts` |
| Stable connection before retry-count reset | 10 seconds | `connection-supervisor.ts` |
| Bridge hello wait | 15 seconds | `HerdrBridgeSession.kt` |
| Bridge request deadline | 35 seconds | `HerdrBridgeSession.kt` |

OS suspension can delay client timers. A probe tests runtime synchronization,
not just whether the bridge process can answer a ping.

## Durable sends

`CommandOutbox` stores pending commands in app-private AsyncStorage. This is
local, unencrypted message content, like drafts and cached conversations;
credentials remain in the native Keystore-backed secret store. Queue writes
are serialized. The UI clears a draft only after its command is saved.

A logical command has one stable `commandId`. Each wire attempt has a different
request `id`, used only to correlate that attempt's response. Never create a new
command ID merely because the response was lost.

The bridge advertises `durableCommands`. It persists command identity and
outcome on the remote host, independently of the short-lived SSH bridge process.
The action/payload fingerprint and target preconditions must match on retry.
Cached success is returned without repeating the operation. Storage errors must
fail closed, not silently disable deduplication.

Upgrading an older deployment hardens verified user-owned `.local`/`share`
directories against group/world writes and makes the application directory
private. Existing command history is preserved. Symlink/foreign-owner failures
name the offending path; never delete the journal or initialization marker as
a reconnection workaround.

There is an unavoidable boundary: sending `agent.prompt` to Herdr and committing
the bridge ledger are not one transaction. If the bridge dies between those
steps, the outcome is uncertain, not safely retryable. Automatic replay stops
for that command and later commands to the same agent. The user can inspect the
conversation; the client does not claim exactly-once execution.

| Local state | Meaning |
| --- | --- |
| `queued` | Saved locally; waiting to send or retry the same ID |
| `sending` | An attempt is in progress |
| `sent` | The bridge acknowledged the command, not completion of the agent's work |
| `failed` | A definite error or invalidated/expired target needs attention |
| `uncertain` | It may have executed; do not automatically submit it again |

Delivery has a 24-hour client queue horizon and a 200-entry local bound. Expiry
never means "send with a new ID." A full/corrupt/unwritable queue preserves the
draft and surfaces an error. Do not clear corrupt storage to make startup look
successful.

Answers carry the question identity; sends carry pane/provider-session
preconditions. Interrupts require a live connection and are not automatically
replayed into a later run.

## Snapshot reconciliation

The repository retains its last transcript while detached and persists fetched
conversations. Only one conversation fetch per agent runs at a time.
Generation checks reject responses from a replaced attachment.

On recovery, fetch authoritative snapshots, including the visible conversation
even if its agent has already finished. Pending local messages are an overlay,
not edits to the server transcript; snapshot replacement cannot erase them.
Before a first send, capture existing remote message IDs. Acknowledged messages
are matched only to new remote user-message IDs, with consumed IDs recorded so
identical repeated messages are not mistaken for one another.

Events accelerate updates; they are not an ordered durable replay stream.
This implementation does not add a server daemon or a `since_seq` protocol.
Foreground refresh cadence and the absence of synthetic typing are documented
in [Markdown rendering](markdown-rendering.md).

## Background operation

The optional native `dataSync` foreground service supplies a notification and
process priority while work/queued sends are active. Android foreground-service
start restrictions, notification permission, service timeout, and platform
termination must all be handled without breaking the conversation.

Android's time budget is cumulative, not reset simply by completing a short
agent run. A foreground service does not exempt sockets or JavaScript timers
from Doze, and user force-stop stops local work. The supervisor suspends when
background execution is unavailable and probes/reconnects on foreground.

Native manifest entries live in the local module and merge into builds; do not
edit generated `android/app/src/main/AndroidManifest.xml`. Rebuild the Android
development app after native or NetInfo changes.

## UX

Queued-message status is immediate. Brief connection blips do not interrupt
reading or typing. The current status component uses this progression:

| Disconnected duration | UI |
| --- | --- |
| Under 10 seconds | No outage banner; pending-message status still appears |
| 10-40 seconds | Small connection/network status |
| 40 seconds or longer | Non-modal reconnect notice |
| 2 minutes or longer | Notice includes an optional Reconnect now action |

Fatal trust/authentication errors bypass that delay and link to server
controls. Uncertain delivery is distinct from a definite send failure.

Never clear/dim the transcript, steal keyboard focus, or repeatedly show an
error dialog for transient network failures. Ambiguous delivery and local
storage failures remain visible rather than being disguised as success.

## Failure-injection checklist

Use a disposable agent and a harmless prompt; do not send test commands to a
user's ongoing task.

1. Disconnect the device network during streaming and restore it. The transcript
   must remain visible and catch up automatically.
2. Queue a message while disconnected, restart the client, then reconnect.
   The logical ID must be unchanged and only one remote action accepted.
3. Drop the response after dispatch; restart the bridge and resend the same ID.
   It must return the ledger result or report uncertainty, never blindly repeat.
4. Replace the network while connection startup is pending. There must be only
   one effective attachment; late results cannot restore stale state.
5. Fail one of two devices. The other must remain usable and selected.
6. Reject credentials/change the host key. Automatic retries must stop.
7. Disconnect/delete a host explicitly. Foregrounding must not resurrect it.
8. Background with and without notification/service support. Resume after Doze,
   service timeout, and process death; verify recovery rather than assuming
   continuous background execution.
9. Inject full/corrupt local storage and ledger failure. Preserve input and show
   an actionable failure; do not transmit without durable protection.
