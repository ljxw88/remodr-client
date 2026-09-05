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
Claude Code, Codex, Copilot, or OpenCode is installed. Default session/socket
values are `default` and `~/.config/herdr/herdr.sock`; see the bridge's
`HERDR_SESSION` and `HERDR_SOCKET` handling for overrides.

Model, reasoning-effort, and context choices in the mobile picker come from the
bundled [`agent-catalogue.ts`](../src/domain/agent-catalogue.ts), not a live model
discovery API. Update that catalog with the app when supported choices change;
it is separate from the server's provider-installation catalog.

## Transport and deployment

```text
HerdrRepository
    -> HerdrBridgeTransport (protocol 1 NDJSON)
    -> RemoteCore / SSHJ non-PTY exec
    -> herdr_mobile_bridge-<sha256>.py
        -> Herdr Unix socket
        -> provider transcript files
```

The app bundles
[`herdr_mobile_bridge.py`](../modules/remote-core/bridge/herdr_mobile_bridge.py)
and deploys it with SFTP under `~/.local/share/remote-workspace/`. Native
[`BridgeDeployment`](../modules/remote-core/android/src/main/java/com/remoteworkspace/remotecore/BridgeDeployment.kt)
verifies content and publishes a versioned launch path; servers without atomic
rename use a verified private staging file. There is no new public TCP service.

Stdout contains protocol NDJSON only; diagnostics go to stderr. The bridge is
self-contained, so the bundled Python file is the entire remote runtime.
Changes to that asset require rebuilding and reinstalling the Android app.

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

## Provider adapters

| Provider | Current conversation source | Limits |
| --- | --- | --- |
| Copilot | `~/.copilot/session-state/<id>/events.jsonl`, plus session database TODOs | Structured messages, tool activity and `ask_user` questions; requires a known provider session |
| Claude Code | Matching JSONL files under `~/.claude/projects/` | Defensive role/content parsing, no structured question normalizer |
| Codex | Matching JSONL files under `~/.codex/sessions/` | Defensive role/content parsing, no structured question normalizer |
| OpenCode | Herdr `agent.read` | `_load_opencode` has no semantic adapter |
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

## Related decisions

- [Native bridge boundary](adr/008-herdr-mobile-bridge.md)
- [Per-device runtime ownership](adr/010-multi-device-herdr-runtime.md)
- [Durable recovery](adr/015-connection-recovery.md)
- [Reconnect, queueing, and background behavior](connection-resilience.md)
