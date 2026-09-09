# Herdr integration

[Documentation index](README.md)

For overall ownership, see [architecture](architecture.md). This guide covers
the remote bridge and provider adapters.

## Runtime requirements and compatibility

The server needs SSH/SFTP access, Python 3 with the bridge's standard-library
dependencies (including SQLite), Herdr, and the OpenCode or GitHub Copilot CLI.
Herdr 0.8.2/protocol 20 and Copilot CLI 1.0.80 are previous development
baselines, not an exhaustive support matrix or a claim about what is installed
on the reader's server.

The bridge reads Herdr's provider catalog at runtime. It does not assume that
OpenCode or Copilot is installed. Default session/socket values are `default`
and `~/.config/herdr/herdr.sock`; see the bridge's
`HERDR_SESSION` and `HERDR_SOCKET` handling for overrides.

Incoming snapshots also tolerate providers unsupported by this app, including
Cursor Agent from an older bundled bridge. Their manifests are marked unavailable
with an explicit reason, and existing agents/conversations use the `unknown`
provider rather than failing the entire connection. Outbound creation accepts only OpenCode and Copilot; removed providers are never
mapped to a different supported provider.
Reloading JavaScript does not replace the native bundled bridge: rebuild and
reinstall the app to deploy the OpenCode adapter.

OpenCode is listed first and selected by default when available. Its integration
uses the exact session reported by Herdr's OpenCode plugins, not a guessed
session from the project directory. See [OpenCode integration](opencode-integration.md)
for account support, installation requirements, read-only storage limits and the
future native HTTP/SSE boundary.

OpenCode models are discovered from the selected remote workspace, while
Copilot model/reasoning/context choices come from its bundled catalogue. See
[model sources](model-catalogues.md). OpenCode users should authenticate
ChatGPT/OpenAI and Anthropic through OpenCode's `/connect` workflow on each
remote host; Remodr does not launch standalone Codex or Claude Code agents.

Live retuning is resolved by
[`agent-capabilities.ts`](../src/domain/agent-capabilities.ts), independently of
the model catalogues. Copilot supports model/reasoning/context settings;
OpenCode supports its live reasoning variants only. The runtime agent's
`capabilities.supportsRetuning` controls availability:

| Reported value | Client behavior |
| --- | --- |
| `true` | Enable the client-supported settings UI |
| `false` | Disable entry and reject submission |
| Omitted by an older bridge | Preserve Copilot behavior; OpenCode variants remain disabled |

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
| OpenCode | Read-only SQLite session/message/todo storage, scoped by Herdr's native session ID | Semantic text, tool activity, current ordered plan, `question` tools and blocked TUI dialogs as Copilot-style needs-input, and verified TUI reasoning-variant selection; native permission APIs and live model switching are not yet wired |
| Copilot | `~/.copilot/session-state/<id>/events.jsonl`, plus session database TODOs | Structured messages, tool activity and `ask_user` questions; requires a known provider session |
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

### Copilot startup identity and workspace trust

Copilot can be ready for input before it writes `events.jsonl`, opens
`session.db`, or reports its session to Herdr. Depending only on the open
database deadlocked the first mobile message, especially after reconnecting
the bridge or restarting an agent to change reasoning settings.

The adapter first verifies the foreground Copilot process. An open session
database remains authoritative; otherwise it reads that exact process's
`inuse.<pid>.lock` markers under `~/.copilot/session-state/`. Marker content,
ownership and modification time must match the live process, and the pane's
foreground binding is checked again after inspection.         Markers older than the
process cannot revive a session from a reused PID. Multiple candidate sessions
remain an explicit unresolved identity, not a reason to pick the newest folder.
After `/clear`, a leftover current-PID marker for the previously bound
session is dropped when exactly one other live marker remains. Herdr's
Copilot native ID is not a tie-break; it can stay stale. Multiple open
session databases still fail closed.
Messages still require exact provider/session/pane preconditions and durable
command IDs. No synthetic first prompt or provider transcript is created.

For Copilot launched from Remodr, the selected workspace is remembered as
trusted before startup, using Copilot's documented `config.json.trustedFolders`
setting. The same preparation runs before a same-session restart. Only the
canonical project directory is added; existing settings and JSONC comments are preserved, and
configuration errors stop the launch rather than silently replacing the file.
This is separate from **Allow tools automatically** and does not grant
`--allow-all-paths` or automatically approve tool requests. It prevents the
startup trust question on future launches; it does not send blind keystrokes
to dialogs in already-running external agents.

Bridge changes require rebuilding and reinstalling the Android app so its
content-addressed remote deployment contains the updated adapter.

## Related decisions

- [Native bridge boundary](adr/008-herdr-mobile-bridge.md)
- [Per-device runtime ownership](adr/010-multi-device-herdr-runtime.md)
- [Durable recovery](adr/015-connection-recovery.md)
- [Reconnect, queueing, and background behavior](connection-resilience.md)
