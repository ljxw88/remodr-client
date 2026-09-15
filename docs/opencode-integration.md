# OpenCode integration

[Documentation index](README.md) | [Provider contract](herdr-mobile-architecture.md)

## Supported architecture

Remodr uses OpenCode's structured HTTP/SSE API for agents it creates. It does
not reconstruct chat messages, questions, permissions, or model controls from
terminal text in native API mode.

```text
Android app
    -> authenticated SSH
    -> bundled Python bridge
    -> authenticated HTTP/SSE on 127.0.0.1
    -> server inside the Herdr-managed OpenCode TUI
```

Herdr still owns the pane and reports the selected root OpenCode session. The
bridge uses that exact session ID for every read and mutation. It never selects
a session by cwd, database mtime, title, or "newest session."

This integration was developed against OpenCode 1.18.30, source-checked against
1.18.31, and exercised with Herdr 0.9.0 / protocol 22. OpenCode 2 has a separate
plugin and client model and is not implicitly covered by this compatibility
statement.

## Host setup

General users do not install a Remodr-specific plugin or configure a database.
On the remote machine, as the same Unix user Remodr connects as:

```sh
# Install OpenCode.
curl -fsSL https://opencode.ai/install | bash
opencode --version

# Start OpenCode once and use /connect to authenticate a provider.
opencode

# Install Herdr.
curl -fsSL https://herdr.dev/install.sh | sh
herdr --version

# Install Herdr's bundled OpenCode integration.
herdr integration install opencode
herdr integration status
```

`herdr integration status` must report `opencode: current`. Restart OpenCode
TUIs that were already running when the integration was installed or updated.
Then connect Remodr and create a new OpenCode agent from the app; Remodr supplies
the loopback server arguments and credentials automatically.

OpenCode creates its own application data, and Remodr creates its command and
server-binding SQLite files automatically under
`~/.local/share/remote-workspace/`. No PostgreSQL/MySQL service, schema command,
or manual database migration is required. The remote home directory must be
writable by the SSH user.

Do not launch the managed TUI with `--pure`; that disables the OpenCode plugins
Herdr uses to report status and the selected root session.

`OPENCODE_BIN` may select the executable used by the bridge's short-lived
bootstrap process. Without it, the bridge checks its SSH `PATH`, then
`~/.opencode/bin/opencode`. The Herdr manifest and bootstrap executable must
refer to compatible OpenCode installations and data directories.

Provider credentials stay in the remote OpenCode installation. They are not
copied into Remodr's model catalogue, Android storage, or bridge protocol.

## Agent creation and server ownership

OpenCode needs a real session before the first prompt so durable mobile commands
can bind to an exact identity. Creation therefore has two stages:

1. After Herdr creates the pane, the bridge starts a temporary authenticated
   `opencode serve` process on loopback, creates an empty session in the
   workspace through `POST /session`, then stops that temporary server.
2. Herdr starts the TUI with:

   ```text
   opencode --hostname 127.0.0.1 --port 0 --session <session-id>
   ```

   A fresh username/password is supplied in that pane's launch environment.

Passing an explicit network flag is important. OpenCode 1.18.x otherwise runs
the TUI server through internal worker RPC without a TCP listener. The managed
listener belongs to the TUI itself; it is not a separate server guessed by
directory or port.

Herdr's plugin remains the session authority. The bootstrap ID allows startup,
but native actions are not enabled until Herdr reports the session and the
bridge independently verifies the server.

### Verification chain

An on-disk credential record does not grant access by itself. Before advertising
native capabilities, the bridge proves:

```text
Herdr pane
  -> foreground OpenCode PID and managed launch arguments
  -> exactly one 127.0.0.1 listener owned by that PID
  -> unauthenticated /global/health returns 401
  -> authenticated /global/health reports a supported version
  -> authenticated /session/<Herdr-session-id> returns the same session and cwd
```

The listener is found through `/proc` on Linux or `lsof` on macOS. The bridge
does not scan ports or try arbitrary OpenCode processes. Credentials are sent
only after PID-to-listener ownership and the unauthenticated 401 have been
established.

Verified bindings are cached briefly. Revalidation happens outside the bridge's
runtime lock, so an unresponsive provider cannot stall Herdr snapshots or other
agents. API capabilities disappear while a binding is absent or expired and
return only after successful verification.

## Private server registry

Managed listener credentials must survive a bridge or phone reconnect while
the TUI keeps running. They are stored in:

```text
~/.local/share/remote-workspace/opencode-servers.sqlite3
```

The registry is independent of `commands.sqlite3`. It uses a user-owned `0700`
directory, `0600` regular files, no symlinks or hard links, an exclusive
initialization lock, a pinned schema, bounded entries, integrity checks, and
full SQLite synchronization. Records are scoped to the saved device, remote
user's Herdr session/socket, and pane.

Closing an agent through Remodr removes its record. Authoritative Herdr snapshots
also reclaim records for panes closed elsewhere after a grace period. A missing,
busy, unsafe, stale, or corrupt registry fails closed: the agent stays usable in
compatibility mode, but native capabilities are not advertised.

No credential is included in runtime snapshots, bridge requests, durable command
payloads, diagnostics, URLs, or model responses.

## Native conversation and controls

For a verified managed agent, the bridge reads:

| Data | OpenCode interface |
| --- | --- |
| Messages and tool parts | `GET /session/:id/message` |
| Current TODOs | `GET /session/:id/todo` |
| Pending questions | `GET /question`, filtered to the exact session |
| Pending permissions | `GET /permission`, filtered to the exact session |
| Session/model metadata | `GET /session/:id` and message metadata |

Responses have strict count, text, body-size, type, role, ID, session, and
message/part relationship checks. Synthetic, ignored, reasoning, and unrelated
session content is not shown as chat. Permission metadata is not forwarded to
the phone; only the permission name, display patterns, reusable patterns, and
stable request ID cross the bridge.

Questions preserve OpenCode's ordered multi-question structure, option
descriptions, multi-select flag, and custom-answer flag. The phone renders a
step-by-step form and submits `answers: string[][]` in native order. Permissions
offer OpenCode's exact decisions: **Allow once**, **Always allow**, and
**Reject**.

Native mutations use:

| Action | OpenCode interface |
| --- | --- |
| Send message | `POST /session/:id/prompt_async` |
| Answer question | `POST /question/:id/reply` |
| Answer permission | `POST /permission/:id/reply` |
| Stop current work | `POST /session/:id/abort` |

Every request is pinned to the current provider, pane, and Herdr-reported
session. A request also carries its source (`api`, `sqlite`, or `tui`); an API
request can never fall through to TUI keystrokes if the native binding is lost.

## Delivery and live updates

Messages and answers retain Remodr's durable command ID, local outbox, remote
SQLite receipt, and exact-session preconditions. The bridge marks a native
mutation as potentially delivered immediately before the HTTP write. A timeout
after that point becomes `COMMAND_UNCERTAIN` and is never replayed
automatically. OpenCode accepts a client message ID but does not deduplicate it,
so the ID is used for reconciliation rather than as permission to resend.

One SSE worker follows each owned TUI server through `GET /event`. It uses the
Authorization header and explicit workspace directory. SSE has no replay
cursor, so snapshots remain authoritative and foreground polling remains a
safety net.

Token/part updates are coalesced before crossing SSH. Questions, permissions,
TODO changes, session lifecycle, completion, and errors invalidate immediately.
Each invalidation has a monotonically increasing bridge-local revision; the
mobile repository drains newer revisions without issuing one full transcript
request for every token event.

## Models and variants

New-agent model discovery continues to run `opencode models` in the selected
remote workspace. This returns effective configured provider/model selectors
without forwarding verbose provider options that may contain credentials.

For a verified managed session, **Model Settings** chooses the model used by
future prompts sent from Remodr. The model is encoded in OpenCode's native
`{providerID, modelID}` prompt field. This does not interrupt or retune a turn
already in progress.

OpenCode 1.18.x keeps the desktop TUI picker as client-local state. Selecting a
model in Remodr therefore does not immediately update the TUI footer. Once
Remodr sends a prompt with that model, the turn records the selection and the
tested 1.18.30 TUI reflects it. Different sessions retain their own recorded
models. There is currently no supported TUI model setter that would make the
footer update before a turn.

Compatibility-mode sessions retain the verified TUI reasoning-variant picker.
Its reasoning choices are read from the live TUI and changes are reflected
immediately. Managed API sessions currently expose model selection but not a
separate reasoning-effort picker; adding one requires sanitizing model-specific
variant metadata from OpenCode's provider API. The API-backed path does not open
the command palette or parse its ANSI layout.

## Compatibility mode

A manually launched plain `opencode` TUI has no listener, and an older agent may
not have a registry record. Those agents keep the previous conservative path:

- exact-session read-only SQLite projection for messages, tools, TODOs, and
  persisted question tools;
- visible-TUI question fallback only when Herdr reports the agent blocked;
- verified TUI key navigation for compatible question answers and variants;
- Escape for Stop and `agent.prompt` for messages.

Compatibility requests are explicitly tagged `sqlite` or `tui`. Managed API
records that fail verification do not silently downgrade writes to keystrokes.

## Security limitations

The server binds only to `127.0.0.1`; never use `0.0.0.0`, mDNS, query-string
credentials, proxies, or redirects. The phone reaches it only through the
existing SSH-hosted bridge.

OpenCode and its tools run as the same remote Unix user as the bridge. The
server password prevents accidental and cross-user access when filesystem and
process isolation are intact, but it is not a sandbox boundary against arbitrary
code already executing as that user. In particular, a tool subprocess may
inherit the managed server environment. Provider permission prompts must not be
described as protection from a fully compromised same-user process.

## Sources

- [OpenCode server API](https://opencode.ai/docs/server/)
- [OpenCode CLI](https://opencode.ai/docs/cli/)
- [OpenCode 1.18.31 TUI transport selection](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/cli/cmd/tui.ts#L232-L250)
- [OpenCode 1.18.31 session routes](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/server/routes/instance/httpapi/groups/session.ts)
- [OpenCode 1.18.31 question routes](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/server/routes/instance/httpapi/groups/question.ts)
- [OpenCode 1.18.31 permission routes](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/opencode/src/server/routes/instance/httpapi/groups/permission.ts)
- [OpenCode 1.18.31 question schema](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/schema/src/v1/question.ts)
- [OpenCode 1.18.31 permission schema](https://github.com/anomalyco/opencode/blob/v1.18.31/packages/schema/src/v1/permission.ts)
- [Herdr OpenCode integration](https://github.com/herdrdev/herdr/tree/master/src/integration/assets/opencode)
