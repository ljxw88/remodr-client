# Herdr mobile bridge

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

## Source modules and deployment

Runtime source lives in `remodr_bridge/`. Provider packages under
`remodr_bridge/providers/` own their launch/tuning settings, active-session
resolution, and transcript parsing:

- `copilot/`: native process/session discovery, Copilot event parsing, questions,
  TODOs, and Copilot-specific tuning.
- `opencode/`: OpenCode launch settings, native session identity and read-only SQLite transcripts.

Shared orchestration, protocol, transport, and durable storage stay outside
provider packages. The provider registry is the integration point; adding a
provider should not require adding branches throughout the runtime.
This refactor does not imply feature parity: existing provider capabilities
and restrictions below remain unchanged.

| Module | Responsibility |
| --- | --- |
| `remodr_bridge/bridge.py` | Protocol dispatch, synchronized state, and orchestration |
| `remodr_bridge/runtime.py` | Snapshot normalization and session reconciliation |
| `remodr_bridge/session_registry.py` | Session bindings, launch/identity state, scoped caches and questions |
| `remodr_bridge/activity.py` | Session-bound transcript/terminal output recency |
| `remodr_bridge/lifecycle.py` | Workspace and agent create/rename/close operations |
| `remodr_bridge/commands.py`, `ledger.py` | Durable command preconditions, receipts, and storage |
| `remodr_bridge/questions.py` | Shared question-answer delivery |
| `remodr_bridge/subscriptions.py`, `transport.py` | Herdr events and socket I/O |
| `providers/base.py` | `ProviderSpec`, `ProviderAdapter`, and the explicit `ProviderHost` contract |
| `providers/__init__.py` | Ordered provider registry and normalized provider selection |
| `providers/<provider>/settings.py` | That provider's labels, flags, effort choices, and capabilities |

Copilot's `processes.py`, `sessions.py`, `transcript.py`, and `tuning.py` separate
OS process inspection, identity resolution, transcript decoding, and live
retuning. OpenCode reads its exact reported session from SQLite.
Runtime publication and Herdr I/O stay with the host. Session state belongs to
`Bridge.sessions`, whose explicit registry methods replace mutable host
dictionaries. Durable-command state remains in the ledger.

`herdr_mobile_bridge.py` is a source-tree compatibility entrypoint. Android does
not upload that file on its own. `build_bundle.py` packages the runtime modules
and `archive_main.py` into a deterministic `herdr_mobile_bridge.pyz`; the native
Gradle task runs it before asset merging. Tests, caches, and build helpers are
excluded. The complete archive is byte-verified and deployed to a content-addressed
`.pyz` path, so an update cannot mix old and new provider modules.

```sh
python3 build_bundle.py --output /tmp/herdr_mobile_bridge.pyz
python3 /tmp/herdr_mobile_bridge.pyz --version
```

`--version` imports the runtime and reports its protocol/providers without
contacting Herdr or creating a session. Normal execution remains protocol-1
NDJSON on stdin/stdout. The remote server needs Python and the existing standard
library dependencies, not pip packages or an extraction step.

New providers need an adapter, registry entry, and provider-level regression
coverage, plus the corresponding mobile provider/model-catalogue support.
Keep shared session isolation and durable command preconditions in the runtime
rather than duplicating them in provider adapters.

## OpenCode model discovery

`opencode.models` accepts `{workspaceId, refresh}` and returns
`{workspaceId, cwd, models}` with bare `provider/model` selectors only.
It runs `opencode models` (adding `--refresh` on request) in the verified
workspace directory using the existing executable resolution. Credentials,
verbose metadata and raw stderr are not forwarded. An empty native list is
distinct from a failed discovery.

The adapter verifies the workspace directory and filesystem identity before
and after discovery. Its 32-second total budget reserves time for the final
Herdr read; stdout is capped at 2 MiB, selectors at 512 characters, and the
list at 10,000 entries. Cleanup targets only the owned subprocess group.
The discovery child does not inherit Herdr pane-reporting variables and does
not create sessions, send inference, or manipulate existing TUI panes.

OpenCode controls provider authentication, project overrides and catalogue
caching. Its native refresh can fall back silently, so this endpoint does not
claim successful upstream refresh or prove every model's account entitlement.
See [Model catalogues](../../../docs/model-catalogues.md).

## Session ownership and locks

`SessionRegistry` owns launch IDs, observed/process-bound identity state,
diagnostic deduplication, launch tuning and permission choices, transcript/tuning
caches, and pending questions with their session scopes. `SessionKey` and
`SessionBinding` are immutable internal records, not new wire fields. Cache and
question payloads are copied on entry and retrieval so a parser or reply consumer
cannot mutate registry-owned values through an alias.

Normalization binds the effective identity after provider-specific inspection.
First identification retains launch settings; rotation clears the previous
session's tuning/transcript/question state without changing the pane's permission
choice. Pruning distinguishes live shell panes from live agents. Successful
agent/workspace closure also forgets the removed state when the following
runtime refresh fails, rather than leaving old cached questions reachable.
Provider parsers and identity authority rules are otherwise unchanged.

| Lock | Owner and contract |
| --- | --- |
| `refresh_lock` | Bridge-wide reentrant lock for normalization, conversation reads, retuning and runtime/session removal. Provider read/bind sequences run under this lock. |
| `state_lock` | Short access/publication of bridge runtime, raw agents and pending launch projections. Providers no longer receive this lock. |
| Registry lock | Private reentrant lock for in-memory registry operations only; never performs Herdr/file I/O, callbacks or bridge-lock acquisition. |

Nested acquisition order is `refresh_lock -> state_lock -> registry lock`;
`state_lock` can be omitted when only session state is needed. Do not acquire
`refresh_lock` while holding `state_lock`. Registry methods lock themselves;
private `_invalidate` requires the registry lock. `_normalize_snapshot` acquires
the refresh lock even when called outside `_refresh_runtime`.

Subscription bookkeeping and stdout use their existing separate locks. They
release those locks before entering refresh/registry operations, and identity
diagnostics are emitted after registry updates release their lock. Ledger
reservations, mutation accounting, receipt persistence and replay rules are not
part of this registry.

The source entrypoint and `Bridge` facade remain available. Former mutable
session dictionaries were internal implementation details, not supported
integration APIs; consumers should use registry operations rather than replacing
or mutating its private containers.

## Cross-language protocol fixtures

`fixtures/protocol/*.json` contains synthetic, checked-in wire contracts shared
by `test_protocol_contract.py` and `src/domain/protocol-contract.test.ts`.
The conversation fixtures include source events, terminal text, session
bindings, runtime agent capabilities, and canonical output. Python writes the source events to isolated
session files under the bridge directory, then uses production bridge dispatch,
runtime normalization, and provider readers. It compares entire conversations
and the runtime agent's session fields and capabilities with the fixtures. No real sessions,
credentials, Herdr server, or provider CLI are used.

Coverage includes Copilot session replacement on the same pane, OpenCode
semantic transcripts, structured questions and tool activity, explicit null
session identity in terminal fallback, and durable accepted/uncertain responses.
Durable fixtures exercise the real SQLite ledger and verify replay from a new
bridge instance without repeating delivery.

Jest reads those same JSON files through the production conversation/response
schemas and session/capability helpers. Strict parsed equality catches fields silently
stripped or defaulted by a schema; separate tests specify legacy omitted
identity and question-default behavior. The capability contract includes the
bridge's existing `supportsRetuning` field, so it cannot silently disappear in
mobile schema parsing. Jest does not invoke Python.

Run both suites from the repository root:

```sh
python3 -m unittest discover -s modules/remote-core/bridge -p 'test_protocol_contract.py' -v
npm test -- --runInBand src/domain/protocol-contract.test.ts
```

To change a contract intentionally, edit the synthetic source and canonical
JSON together, review the wire-format diff, and run both suites. There is no
snapshot-update or automatic fixture-rewrite mode: a failing comparison must
not silently bless changed bridge output.

## Providers and model settings

The bridge supports **OpenCode and GitHub Copilot**, in that preferred selection
order.
Availability comes only from Herdr's `server.agent_manifests`, never the bridge
host's `PATH`. Herdr must advertise the provider and launch its interactive CLI.
The mobile provider ID and Herdr launch kind for OpenCode are `opencode`.
Removed Cursor Agent panes become `unknown` and retain terminal fallback instead
of being misidentified as OpenCode. The generic executable name `agent` alone
does not identify a supported provider.

`agent.create` accepts optional `model`, `effort`, and `context` fields:

| Provider | Model | Effort | Context | Permission bypass |
| --- | --- | --- | --- | --- |
| OpenCode | `--model <provider/model>` | Unsupported | Unsupported | `--auto` |
| Copilot | `--model <id>` | `--effort <value>` | `--context <value>` | `--allow-all-tools` |

`bypassPermissions: false` omits the bypass flag for every provider; an absent
setting retains the existing default of `true`. OpenCode's `--auto` approves
permissions unless explicitly denied. Omitting it leaves the user's OpenCode
permission policy in effect; it does not force an ask-every-time policy.

OpenCode creation uses a temporary password-protected loopback server to create
an empty session in the known workspace cwd, then closes that server and launches
the Herdr TUI with `--session <existing-id>`. The native Herdr session report is
still required before durable sends. Bootstrap sends no inference prompt and
does not rewrite user credentials or plugin configuration.

OpenCode conversations read the exact session's supported SQLite rows through a
read-only transaction, including WAL data. Missing identity keeps the explicit
terminal fallback; invalid identifiers, missing exact sessions, unsupported
schemas and active reverts do not silently select another session. No live API
question/permission controls or streaming subscription is advertised.
In-chat reasoning variants use the verified native TUI chooser described below.
See [OpenCode integration](../../../docs/opencode-integration.md)
for storage overrides, installation and account support.

When the native `todo` table is present, the same transaction appends one
current `todo_update` snapshot for the exact session. Rows are ordered by native
position; completed maps to `done`, while pending, in-progress and cancelled
remain distinct. Content, status, priority, position and bounds are validated
before any plan is published. Empty/replaced lists disappear with the next
authoritative conversation snapshot. The bridge never parses `# Todos` from
terminal output or final assistant prose.

Omitted, null, or blank tuning values retain CLI defaults. Non-string values
fail with `INVALID_MODEL`, `INVALID_EFFORT`, or `INVALID_CONTEXT`; populated
settings unsupported by that provider fail with `UNSUPPORTED_TUNING` before a
pane is created. Unknown effort/context values are also rejected, not dropped.
Copilot accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`;
Actual model availability and model-specific effort support depend on the
installed CLI/account. The bridge passes nonempty model IDs through; Copilot's
catalog and OpenCode's native model discovery decide which choices to offer.
Only Copilot accepts `default` and `long_context` as a separate context setting.
OpenCode reasoning variants are selected after launch, not passed as an
unsupported root-TUI flag.

**Live retuning supports Copilot settings and OpenCode variants.** Both hello
`capabilities.providerCapabilities[provider].supportsRetuning` and each
agent's `capabilities.supportsRetuning` report this explicitly. Clients must
not equate creation tuning with live-retuning support. `agent.retune` rejects
unsupported providers with `PROVIDER_NOT_TUNABLE` before issuing CLI input.
Copilot retains its existing `/model` and session-restart behavior; its
`--session-id`, `/exit`, and session-log parsing never apply to other providers.
Creation settings remembered by the bridge override lagging native session
metadata. OpenCode's semantic read adapter does not imply native HTTP model
switching or question controls.

For OpenCode, `agent.variant_options` takes `{agentId, providerSessionId}` and
returns `{modelLabel, modelToken, currentVariant, variants}`. Names come from
the active chooser, not the last submitted message or an offline model list.
`currentVariant: null` means Default. To apply, send `agent.retune` with
`{agentId, providerSessionId, modelToken, variant}`; `variant: null` clears the
override. Do not include changed generic model/effort/context settings.

Both operations pin the live session and terminal and require an idle,
recognizable TUI with an empty native prompt. The bridge opens the command
palette without submitting a prompt, verifies the unique variant command and
picker, and checks ANSI focus before selecting. It reopens the picker to
confirm the actual value. Default keybindings and a fully visible picker are
required; ambiguous layouts, hidden choices, native drafts, busy agents, and
session/model changes produce explicit errors. Settings operations do not
write OpenCode's database or user configuration.

Flag references:
[OpenCode CLI](https://opencode.ai/docs/cli/).

## Output activity for agent ordering

`runtime.snapshot` accepts optional `{"includeActivity": true}`. These requests
attach `lastOutputAt` (Unix milliseconds) to agents with known output recency.
Ordinary snapshots and status events reuse observed activity without doing extra
transcript or terminal reads.

The provider adapter's `output_path()` selects the same session-specific
transcript used for conversation reading. Copilot uses its last-write time
without parsing the entire conversation. Providers without a transcript output
path use changes in a bounded, ANSI-stripped `recent_unwrapped` text sample;
their first read establishes a baseline rather than inventing a historical
output time. Polling, status changes, and tab renames do not themselves advance
activity. Transcript writes include message and tool/session-log activity;
terminal fallback reflects visible terminal text changes.

Activity is isolated by agent/provider/session/terminal identity and pruned when
agents disappear. Optional activity-read failures are diagnosed without failing
the runtime snapshot. The mobile list requests activity only while focused,
foregrounded, and connected; full transcript polling is not needed for unopened
agents.

## Session identity and `/clear`

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

Runtime agent records also forward Herdr's `state_change_seq` as optional
`statusRevision`. The mobile client uses it to distinguish completed work from
duplicate status snapshots. Completion receipts and read/unread state remain
client-owned; the bridge does not acknowledge or mutate Herdr's seen state.
Snapshots include a bridge-local monotonic `runtimeRevision`, allowing clients
to reject late snapshots within an attachment without relying on wall clocks.

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
`pane.process_info` and verifies the **foreground process-group leader** in that
pane. On macOS this is the `copilot` executable. Linux can omit `argv0` and start
Copilot through VS Code's shell/Node launchers; `/proc` executable, parent, owner,
and process-group metadata identifies the unique native Copilot runtime in that
verified launcher chain. Arbitrary child/background SDK processes, unrelated
groups, and ambiguous sibling runtimes are not accepted.
Linux's ` (deleted)` executable marker after an in-place CLI update is recognized;
an otherwise live, verified runtime does not need to be restarted.

Only the selected runtime PID's open descriptors are inspected: Linux uses `/proc/<pid>/fd`;
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
