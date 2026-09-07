# Herdr integration

[Documentation index](README.md)

For overall ownership, see [architecture](architecture.md). This guide covers
the remote bridge and provider adapters.

## Runtime requirements and compatibility

The server needs SSH/SFTP access, Python 3 with the bridge's standard-library
dependencies (including SQLite), Herdr, and each provider CLI you intend to
launch. Herdr 0.8.2/protocol 20, Copilot CLI 1.0.80, and Codex CLI 0.146.0 are
previous development baselines, not an exhaustive support matrix or a claim
about what is installed on the reader's server.

The bridge reads Herdr's provider catalog at runtime. It does not assume that
Claude Code, Codex, Copilot, or Cursor Agent is installed. Default session/socket
values are `default` and `~/.config/herdr/herdr.sock`; see the bridge's
`HERDR_SESSION` and `HERDR_SOCKET` handling for overrides.

Incoming snapshots also tolerate providers unsupported by this app, including
OpenCode from an older bundled bridge. Their manifests are marked unavailable
with an explicit reason, and existing agents/conversations use the `unknown`
provider rather than failing the entire connection. Outbound creation still
accepts only the four supported providers; OpenCode is never mapped to Cursor.
Reloading JavaScript does not replace the native bundled bridge: rebuild and
reinstall the app to deploy updated Cursor launch support.

Model, reasoning-effort, and context choices in the mobile picker come from the
bundled [per-provider JSON catalogues](../src/domain/model-catalogues/), loaded
by [`agent-catalogue.ts`](../src/domain/agent-catalogue.ts). Run the
[model refresh script](model-catalogues.md) on a maintenance machine and ship
the resulting JSON with the app. This is separate from the server's
provider-installation catalog. Launch configuration uses each provider's own
flags; catalogue entries do not grant permission to retune a running agent.

Live retuning is resolved by
[`agent-capabilities.ts`](../src/domain/agent-capabilities.ts), independently of
the model catalogues. This client currently implements Copilot retuning only.
For that provider, the runtime agent's `capabilities.supportsRetuning` controls
availability:

| Reported value | Client behavior |
| --- | --- |
| `true` | Enable the client-supported settings UI |
| `false` | Disable entry and reject submission |
| Omitted by an older bridge | Preserve the previous Copilot-only behavior |

The schema deliberately preserves an omitted field instead of defaulting it to
`false`; a malformed reported value is not treated as a legacy omission. A
remote `true` cannot enable a provider the client does not implement. The
composer, action menu, settings-flow validation, and repository submission
boundary share this decision. Open drafts remain editable if support changes,
but applying requires the current owning device to be connected and supported.
The bridge remains authoritative if its state changes after the last snapshot.

## Transport and deployment

```text
HerdrRepository
    -> HerdrBridgeTransport (protocol 1 NDJSON)
    -> RemoteCore / SSHJ non-PTY exec
    -> herdr_mobile_bridge-<sha256>.pyz
        -> Herdr Unix socket
        -> provider transcript files
```

The [modular Python source](../modules/remote-core/bridge/remodr_bridge/) is
packaged by [`build_bundle.py`](../modules/remote-core/bridge/build_bundle.py)
into `herdr_mobile_bridge.pyz`. Gradle builds this archive automatically and
includes it as an APK asset. The app deploys it with SFTP under
`~/.local/share/remote-workspace/`. Native
[`BridgeDeployment`](../modules/remote-core/android/src/main/java/com/remoteworkspace/remotecore/BridgeDeployment.kt)
verifies content and publishes a versioned launch path; servers without atomic
rename use a verified private staging file. There is no new public TCP service.

Stdout contains protocol NDJSON only; diagnostics go to stderr. The zipapp
contains all runtime modules and runs directly with `python3 -u`; it requires no
remote extraction, package installation, or sibling source files. Its checksum
covers every module, so a provider change produces a new deployment version.
Changes to any bridge module require rebuilding and reinstalling the Android app.

Hello carries version/capability information and runtime readiness. A fatal
journal failure is distinct from unavailable Herdr. Successful ping only proves
bridge responsiveness; connection establishment also needs a runtime snapshot.
The [bridge contract](../modules/remote-core/bridge/README.md) owns the full
request/response and durable-command specification.

## Identity and agent actions

Each bridge receives `REMOTE_WORKSPACE_DEVICE_ID`. Agent IDs combine the Herdr
session, saved device ID, and stable pane ID. The repository indexes ownership
from snapshots; it cannot recover a device by parsing the hashed agent ID.

One runtime/transport is retained per connected device. Pure repository
selection is view state; an explicit device-connect action may also enable a
connection. Automatic reconnect never changes the selected device.

Agent creation uses `server.agent_manifests`, `tab.create`, and `agent.start`.
Creation code handles partial setup cleanup. Runtime subscriptions trigger fresh
Herdr snapshots; per-pane status subscriptions supplement the global feed.
Closing the mobile attachment does not close Herdr panes or terminate agents.

An agent ID is stable across `/clear`; its `providerSessionId` is not.
Conversation reads reconcile the current session even without a lifecycle event,
and responses identify the session actually read. Session-bound caches and launch
bookkeeping must follow that reported identity rather than the original launch
ID. See [session rotation and queued-command isolation](connection-resilience.md#clearing-or-replacing-a-provider-session).

For machine-specific failures, the agent action menu includes **Session
diagnostics**. It uses that device's existing authenticated SSH connection to
show sanitized foreground-process and session metadata. It does not expose
credentials or arbitrary command execution. Linux Copilot launchers may involve
VS Code and Node wrapper processes; the bridge follows only the verified
foreground launcher chain to the native runtime.

## Provider adapters

| Provider | Current conversation source | Limits |
| --- | --- | --- |
| Copilot | `~/.copilot/session-state/<id>/events.jsonl`, plus session database TODOs | Structured messages, tool activity and `ask_user` questions; requires a known provider session |
| Claude Code | Matching JSONL files under `~/.claude/projects/` | Defensive role/content parsing, no structured question normalizer |
| Codex | SQLite-indexed JSONL rollouts under `CODEX_HOME` (default `~/.codex`) | Legacy messages and paginated completed items; no structured question normalizer |
| Cursor Agent | Herdr `agent.read` | Explicit raw-output compatibility view; no semantic transcript adapter |
| Unknown or unreadable adapter | Herdr `agent.read` | Explicit raw-output compatibility view |

Adapter code does not imply support for every future CLI log schema. If a
source cannot be decoded, the app must not invent semantic messages from raw
terminal output.

Copilot chunk records sharing a message ID are reconciled. These are transcript
snapshots, not a subscription to ephemeral token events. Received text appears
immediately; refresh timing and Markdown behavior belong in
[markdown rendering](markdown-rendering.md).

Structured Copilot questions are normalized from both supported `ask_user`
shapes. See [ADR 014](adr/014-answering-agent-questions.md) for composer/bar
placement and delivery constraints.

### Codex startup and thread identity

Codex 0.153.4 allocates a real thread UUID before the first prompt, but defers
its `SessionStart` hooks and transcript materialization until the first turn.
Requiring the hook's identity before allowing that turn creates a deadlock.

Remodr-created Codex agents include this per-launch configuration:

```text
-c 'tui.status_line=["session-id","model-with-reasoning","current-dir"]'
```

`session-id` is the backwards-compatible name for the current `thread-id` item.
Putting it first keeps the full UUID visible in narrower terminals. For an
already-running Codex session, enable **Thread ID** in `/statusline` and move it
before other fields. This changes presentation, not the conversation.

The bridge reads only the live status footer in that exact Herdr pane. It never
guesses identity from the newest log, a cwd match, or a process's set of writer
locks. `/new` changes the visible UUID immediately, even while Herdr's hook
reference still names the previous session. A hidden/unreadable footer preserves
the last display binding but cannot authorize a send.

Transcript lookup prefers the read-only `state_N.sqlite` index. JSONL metadata
must match the bound thread. Paginated `item_completed` user/agent messages are
preferred over raw response items, which also contain injected project context.
Legacy `user_message`/`agent_message` records remain supported. IDs are stable
between polls, repeated completed items are reconciled, and unchanged logs use
the conversation cache. Missing or compressed rollouts use the explicit terminal
compatibility view rather than inventing messages.

The official `herdr integration install codex` hook remains useful for native
Herdr restore after a turn. Review it through Codex's normal hook-trust UI; do not
disable hook trust. It is not the pre-first-prompt identity source.

Version-specific references:
[deferred startup hooks](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/core/src/session/turn.rs#L264-L269),
[live thread-ID rendering](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/tui/src/chatwidget/status_surfaces.rs#L753-L757),
and [paginated persistence](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/rollout/src/policy.rs#L89-L108).

## Related decisions

- [Native bridge boundary](adr/008-herdr-mobile-bridge.md)
- [Per-device runtime ownership](adr/010-multi-device-herdr-runtime.md)
- [Durable recovery](adr/015-connection-recovery.md)
- [Reconnect, queueing, and background behavior](connection-resilience.md)
