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

## Providers and model settings

The bridge supports **GitHub Copilot, Claude Code, Codex, and Cursor Agent**.
Availability comes only from Herdr's `server.agent_manifests`, never the bridge
host's `PATH`. Herdr must advertise the provider and launch its interactive CLI.
The mobile provider ID and Herdr launch kind for Cursor are `cursor`; detection
also recognizes `cursor-agent` / `cursor_agent`. The generic executable name
`agent` alone is not sufficient evidence of Cursor. OpenCode is not advertised
or launchable; existing OpenCode panes become `unknown` and retain terminal
fallback instead of breaking the mobile provider schema.

`agent.create` accepts optional `model`, `effort`, and `context` fields:

| Provider | Model | Effort | Context | Permission bypass |
| --- | --- | --- | --- | --- |
| Copilot | `--model <id>` | `--effort <value>` | `--context <value>` | `--allow-all-tools` |
| Claude Code | `--model <id-or-alias>` | `--effort <value>` | Unsupported | `--dangerously-skip-permissions` |
| Codex | `--model <id>` | `-c 'model_reasoning_effort="<value>"'` | Unsupported | `--dangerously-bypass-approvals-and-sandbox` |
| Cursor Agent (`agent`) | `--model <id>` | Unsupported | Unsupported | `--force` |

Codex's config assignment is a single argument containing a quoted TOML string;
the table's surrounding single quotes are shell notation, not part of the
argument. `bypassPermissions: false` omits the bypass flag for every provider;
an absent setting retains the existing default of `true`. Cursor's `--force`
allows commands unless explicitly denied; it does not disable its sandbox.

Omitted, null, or blank tuning values retain CLI defaults. Non-string values
fail with `INVALID_MODEL`, `INVALID_EFFORT`, or `INVALID_CONTEXT`; populated
settings unsupported by that provider fail with `UNSUPPORTED_TUNING` before a
pane is created. Unknown effort/context values are also rejected, not dropped.
Copilot accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`;
Claude accepts `low`, `medium`, `high`, `xhigh`, `max`;
Codex accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.
The Codex-only `ultra` setting is available on models advertising it through
Codex's `model/list` API.
Claude's `ultracode` orchestration mode is not a reasoning-effort value in this
contract.
Actual model availability and model-specific effort support depend on the
installed CLI/account. The bridge passes nonempty model IDs through; the app's
JSON catalogs decide which choices to offer. Only Copilot accepts `default`
and `long_context` as a separate context setting. Claude/Cursor context or
thinking variants must be represented by the CLI's model ID, not invented flags.

**Live retuning remains Copilot-only.** Both hello
`capabilities.providerCapabilities[provider].supportsRetuning` and each
agent's `capabilities.supportsRetuning` report this explicitly. Clients must
not equate creation tuning with live-retuning support. `agent.retune` rejects
every other provider with `PROVIDER_NOT_TUNABLE` before issuing CLI input.
Copilot retains its existing `/model` and session-restart behavior; its
`--session-id`, `/exit`, and session-log parsing never apply to other providers.
Non-Copilot tuning reports only settings remembered from bridge-created agents;
externally started sessions have unknown settings. Cursor conversations use
terminal fallback, not an unverified structured-session adapter.

Flag references:
[Claude CLI](https://code.claude.com/docs/en/cli-reference),
[Codex CLI](https://developers.openai.com/codex/cli/reference/) and
[configuration](https://developers.openai.com/codex/config-reference/),
[Cursor parameters](https://cursor.com/docs/cli/reference/parameters).

## Session identity and `/clear`

Codex creation configures a live thread UUID in its status line because current
Codex defers session hooks until the first turn. Only the exact pane's live footer
is identity evidence; old `/status` text and UUIDs in messages are not. The
`session-id` status item is a compatibility alias of `thread-id`.

The live UUID overrides stale hook metadata after `/new`. Missing footer evidence
reports `SESSION_IDENTITY_UNRESOLVED` on reads; commands fail with
`COMMAND_PRECONDITION_FAILED` before input, rather than offering a retry of a
permanent failed receipt. A prior display binding can be retained while a dialog
hides the footer, but it is not authorization to dispatch. See the
[Codex integration guide](../../../docs/herdr-mobile-architecture.md#codex-startup-and-thread-identity).

Every `agent.conversation` request refreshes Herdr's `session.snapshot`
**before** resolving the agent and reading its transcript. For Copilot, native
session references are reconciled against the foreground CLI's open session
database as described below; the native reference is not the sole authority.
This also detects `/clear` session rotations that produce no status event.
When the normalized runtime changes, the bridge emits `runtime.snapshot`
before returning the conversation; unchanged polls do not emit redundant
snapshots merely because the poll timestamp changed.

All conversation responses, including empty semantic transcripts and terminal
fallback, include:

```json
{
  "agentId": "agent-id-from-snapshot",
  "provider": "copilot",
  "providerSessionId": "the-session-used-for-this-read"
}
```

`providerSessionId` is explicitly `null` when unknown. A transcript is selected
by that identity, never by the newest session under a working directory.
Valid empty semantic transcripts return `items: []`; they are not replaced
with old terminal scrollback. A missing/unsupported transcript may still use
terminal fallback. Snapshot failures return an error rather than cached
conversation success, and transcript read errors return
`CONVERSATION_UNAVAILABLE` instead of silently switching to terminal output.

On a reported identity change, the bridge reconciles remembered launch IDs,
invalidates that agent's transcript/question state and old tuning, and reads
the new session's settings. A known launch ID is used only before Herdr has
first reported a session for the pane. Once a reported identity disappears,
the old launch ID is not reused. `agent.retune` independently refreshes the
authoritative identity, so it cannot restart the original pre-clear session
just because no conversation poll ran first. Transcript caches include the
agent ID as well as the provider session, preventing two panes sharing a
session from returning one another's response identity.
Copilot events tagged with a child `agentId` are excluded from the parent
transcript and tuning: internal delegation prompts, replies, and questions
must not be presented as the user's main conversation.

### Copilot foreground-process session authority

Some Herdr versions retain Copilot's original session reference even after
accepting a native clear/session report. The bridge therefore requests
`pane.process_info` and verifies the **foreground process-group leader** is the
exact `copilot` executable in that pane. A child Copilot process, background
SDK process, or another pane's process metadata is not sufficient.

Only that PID's open descriptors are inspected: Linux uses `/proc/<pid>/fd`;
macOS uses `lsof -nP -a -p <pid> -F0pun`. The process must belong to the bridge
user. Only the exact path
`~/.copilot/session-state/<session-id>/session.db` qualifies, not other homes,
sidecars, transcript modification times, directory order, or cwd. A unique
open session database overrides a stale native session reference throughout
runtime normalization, conversations, retuning, and durable precondition checks.
The pane's process-group/shell binding is checked again after inspection.

Inspection is targeted and bounded: two seconds, 512 KiB of descriptor output,
and at most 4,096 Linux descriptors. No system-wide process/file scan is used.
Session results are not cached by PID across refreshes: `/clear` can change the
open database without changing PID, and a restart can reuse a PID. Changed
descriptor evidence goes through the same session-cache invalidation as a
native identity rotation.

High-volume status events are hints: they retain the last process-bound identity
for the same terminal without repeating descriptor scans. This prevents event
backlogs from starving request handling. Explicit runtime/conversation requests
and mutation preconditions always inspect afresh, so hints never authorize a
send or choose the transcript to read.

Multiple candidates or a process change during inspection fail closed:
runtime identity becomes `null`, and conversation/retune requests return
`SESSION_IDENTITY_UNRESOLVED`, rather than selecting an old transcript. If
process metadata or inspection is unavailable, or an idle/new CLI has not opened
its optional session database, on an installation that has not
established process-bound identity, the bridge retains native/launch-ID behavior
and emits an explicit `COPILOT_SESSION_IDENTITY` diagnostic identifying it as
unverified. Repeated identical diagnostics are suppressed. Once a pane has
established process-bound identity in this bridge process, transient inspection
failure cannot restore a stale native ID: it also fails closed until inspection
recovers.

When both descriptor inspection and accurate native reporting are unavailable,
the bridge cannot reliably detect `/clear`. That compatibility fallback remains
limited; it never guesses from the newest session file or working directory.

Runtime reconciliation, conversation reads, and subscription refreshes are
serialized inside the bridge. Herdr/provider changes outside the bridge are
not atomic with a read: a response can still arrive after a newer identity
event. Clients must compare its explicit `providerSessionId` with their current
agent identity and discard stale responses. For terminal fallback, this field
identifies the refreshed target binding; terminal output itself is not a
session-scoped transcript and may contain scrollback.

Session reconciliation does **not** change durable command bindings or
journaled payloads. A queued command for the pre-clear session fails with
`COMMAND_PRECONDITION_FAILED`; rewriting its session while retaining its
command ID fails with `COMMAND_ID_CONFLICT`, rather than rebinding the command.

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
