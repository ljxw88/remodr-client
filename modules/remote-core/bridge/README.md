# Durable bridge commands

The standalone Python bridge still uses NDJSON **protocol 1**. No additional
packages or sibling Python files are needed on the remote host. Its hello
`capabilities` includes `"durableCommands": true` only after a successful
SQLite journal/write/commit availability check. It also advertises
`"durableCommandsRequireSessionIdentity": true` and
`"durableInterruptReplay": false`.

An unavailable journal produces a hello with `durableCommands: false`,
`runtimeReady: false`, `fatal: true`, and a typed `error: {code, message}` (for
example `COMMAND_STORE_UNAVAILABLE`); the bridge then exits without dispatching.
Availability can change after hello: later storage failures still fail closed.

## Wire contract

Legacy requests without `commandId` retain their existing behavior, including
their lack of persistent deduplication. A durable request uses a stable,
canonical UUID independent of the unique transport-attempt `id`:

```json
{
  "protocol": 1,
  "type": "request",
  "id": "transport-attempt-2",
  "commandId": "35b2b300-fdf9-4ab0-9438-d1d5749bcb77",
  "action": "agent.send_message",
  "payload": {
    "agentId": "agent-id-from-snapshot",
    "text": "Continue",
    "expectedProviderSessionId": "provider-session-from-snapshot",
    "expectedPaneId": "pane-from-snapshot"
  }
}
```

The supported durable action names are `agent.send_message`,
`human_request.answer`, and `agent.interrupt`. All require the nonempty
`payload.expectedProviderSessionId` and `payload.expectedPaneId` identity above.
Clients may also send `expectedProvider`, which is checked when present. The
original nested `precondition: {provider, providerSessionId, paneId}` shape is
accepted as an alternative; root expected fields take precedence. Do not change
the representation when retrying the same command ID.

An answer additionally uses its existing
`requestId` and `answer` fields and must match the current active question loaded
from that provider session. The bridge refreshes the runtime before binding a
new command, and rechecks the bound identity before each mutation.

**Initial foreground interrupts are journaled, but must not be automatically
queued/retried across connection loss.** Herdr does not expose a verifiable run
identity: a session/pane match cannot prove that the same run is still working.
After a lost interrupt ACK, use `command.status`, not a fresh interrupt dispatch.
An existing terminal interrupt result is cached like any other result, but an
`unknown` interrupt status is not permission to resend to a possibly new run.

An unknown provider session (`expectedProviderSessionId: null`, absent, or empty)
cannot safely bind any durable mutation and fails closed with
`COMMAND_PRECONDITION_FAILED`. The capability does not make unknown identities
safe for offline replay.

Successful command payloads are unchanged (`{"accepted":true}`). Retrying a
terminal command returns its original response, with only `id` replaced by the
current transport-attempt ID. Action, payload, and preconditions must remain
identical; changing any of them with the same command ID is a conflict.

### Inspect delivery without sending again

Send `command.status` with `payload: {"commandId":"<original UUID>"}` and no
envelope `commandId`. Its successful response payload is:

```json
{
  "commandId": "35b2b300-fdf9-4ab0-9438-d1d5749bcb77",
  "state": "succeeded",
  "response": {
    "protocol": 1,
    "type": "response",
    "ok": true,
    "payload": {"accepted": true}
  }
}
```

States are `unknown`, `in_progress`, `uncertain`, `succeeded`, and `failed`.
`response` is present when a terminal response was saved and has no transport
ID. An abandoned reservation can be `uncertain` without a saved response.
`unknown` means absent **in this scope**, not proof that a command was never
submitted to a different device/session/socket. Storage failure returns an
error, never `unknown`.

`bridge.ping` with an empty payload returns `{"alive":true}` without contacting
Herdr or opening the command store. Dispatch remains serial: a prior slow
operation can delay a ping. A ping ACK tests bridge/transport responsiveness,
not provider responsiveness. Successful runtime initialization is explicitly
`runtimeReady: true` in hello. A failed initial runtime snapshot yields
`runtimeReady: false`, typed hello `error.code: "HERDR_UNAVAILABLE"`, and the
existing connection warning event, even if the bridge can still answer ping.
Clients must obtain a successful runtime snapshot before marking the connection
healthy; ping alone cannot clear runtime/provider failure.

### Errors

| Code | Meaning |
| --- | --- |
| `INVALID_COMMAND_ID` | Not a canonical UUID. |
| `COMMAND_ACTION_UNSUPPORTED` | An envelope command ID was supplied for another action. |
| `COMMAND_ID_CONFLICT` | The ID is already bound to different action/payload content. |
| `COMMAND_IN_PROGRESS` | A reservation is active, or storage is temporarily locked. Query status/retry the same ID later; do not create a replacement. |
| `COMMAND_UNCERTAIN` | Dispatch might have happened, or its outcome could not be durably saved. Do not automatically resend, even with a new ID. |
| `COMMAND_PRECONDITION_FAILED` | The queued target/question changed, or required provider-session/pane identity is missing. |
| `COMMAND_STORE_UNAVAILABLE` | Missing/damaged/insecure/unwritable storage; no fresh durable dispatch is allowed. |
| `COMMAND_STORE_FULL` | Capacity reached; old records were retained and no fresh dispatch occurred. |

Validation errors discovered before attempting a side effect are saved as
`failed`. Errors during/after an attempted mutation, including a multi-batch
question answer, are conservatively `uncertain`. A persistence error after
dispatch also returns uncertainty rather than a false success ACK.

## Storage and limits

The SQLite ledger is
`~/.local/share/remote-workspace/commands.sqlite3`, with mode `0600` in a
`0700` directory. The adjacent private `commands.initialized` marker prevents
silently recreating a missing database.

Native deployment creates `.local/share/remote-workspace` using SFTP `mkdirs`,
which inherits the server's umask and may leave existing directories `0755`,
`0775`, or `0777`. On startup the bridge safely hardens this deployment layout:
it validates each directory's ownership and real-directory type, opens it with
`O_NOFOLLOW`, and changes permissions through the verified file descriptor.
Group/other write bits are removed from `.local` and `.local/share`; the
`remote-workspace` directory becomes `0700`. Existing bridge files, hashes, and
ledger contents are preserved in place, so no command history is reset.

Symlinks, foreign-owned paths, hard-linked files, and insecure ledger/marker
file permissions remain refused. Errors identify the failing path and reason
(including observed/required modes or owner IDs) so ownership/permissions can be
repaired without deleting command history. A directory that cannot safely be
hardened remains a fatal typed startup error; durable mode is never silently
disabled to work around it.

The marker also serializes initialization across bridge processes. SQLite
transactions serialize reservations; committed reservations precede dispatch,
and synchronous terminal commits precede stdout ACKs.

Namespace includes the OS user ID, `REMOTE_WORKSPACE_DEVICE_ID`,
`HERDR_SESSION`, and absolute Herdr socket path. Each command fingerprint binds
its full action/payload, including provider session and pane. The ID is unique
across targets within that namespace: reusing it for a different target is
rejected, rather than accidentally dispatching to that target.

There is no terminal-record expiry or eviction. The hard limit is **10,000
records across namespaces**, and SQLite is limited to **16,384 pages** (64 MiB
with the default 4 KiB page size), plus bounded journal overhead. Stored
responses are limited to 64 KiB. New reservations are refused at capacity.
Existing cached responses remain available. Raw prompts/answers are not stored;
their canonical action/payload SHA-256 fingerprint and terminal result are.
The client's 24-hour outbox age bound does not expire server records: old IDs
remain occupied indefinitely and can never become fresh commands automatically.

A reservation becomes permanently uncertain when its owning PID is no longer
alive, its age reaches **120 seconds**, or the clock moves behind its creation
time. PID reuse can delay detecting a crash until that bound; it can never make
the command eligible for redispatch. Expiry does **not** remove the record.

Do not delete/reset the ledger to resolve capacity or uncertainty while any
client can replay old IDs. Preserve the directory across bridge upgrades and
use local durable storage, not a network filesystem. Database loss, a restored
old backup, or deliberately removing both marker and database destroys evidence
of prior delivery; no bridge-only mechanism can recover it. Such administrative
resets are outside the guarantee and require retiring old client command IDs.
Interrupted first initialization fails closed and requires operator recovery.

## What this does not guarantee

This is persistent duplicate suppression and explicit ambiguous delivery,
**not exactly-once execution**. Herdr `agent.prompt` and the SQLite transaction
cannot commit atomically. If Herdr accepts a prompt and the bridge dies before
recording the result, the ledger can only report uncertainty. It must not
reissue that prompt. Conversely, a bridge can die after reserving but before
sending; that reservation is also uncertain. A lost stdout ACK after a
successful ledger commit is recoverable by returning the cached response.

Provider/pane/question validation rejects stale queued targets observed before
dispatch. Herdr does not accept an atomic expected-session/question condition,
so there remains a race between that check and the provider receiving input.
Other clients or the provider can change the pane/dialog during that interval,
especially between batches of answer keystrokes. This protocol cannot honestly
guarantee atomic target binding or exactly-once effects; clients must surface
uncertainty and must not automatically turn an uncertain operation into a new
command ID.

## Tests

From the repository root (keep test scratch inside the repository):

```sh
mkdir -p modules/remote-core/bridge/.test-work
TMPDIR="$PWD/modules/remote-core/bridge/.test-work" \
  python3 -m unittest discover -s modules/remote-core/bridge -q
rmdir modules/remote-core/bridge/.test-work
```
