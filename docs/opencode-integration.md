# OpenCode integration

[Documentation index](README.md) | [Provider contract](herdr-mobile-architecture.md)

## Direction and researched baseline

OpenCode is the first provider in Remodr's picker and the preferred default when
Herdr advertises it as available. GitHub Copilot, Claude Code and Codex remain
supported. A saved host that lacks OpenCode falls back to the next available
provider, rather than launching an unavailable executable.

OpenCode is a useful integration target because it has a client/server API and
a unified model/provider layer. That reduces the number of provider-specific
mobile adapters, but does not remove account restrictions or make all CLI
behaviors interchangeable.

This work inspected OpenCode **1.18.29** and Herdr **0.8.2** source and the
installed CLIs' version/help output. The sources below are version-pinned where
possible. It is not a claim that every older or future OpenCode database schema
or plugin version is compatible.

## Provider accounts are not interchangeable

Configure credentials in OpenCode on the remote host using its `/connect`
workflow. Remodr does not copy account tokens into its model catalogue or phone.

| Account or service | Verified integration guidance |
| --- | --- |
| GitHub Copilot | OpenCode documents native device-code authentication for a Copilot subscription. Organization policy and model entitlement still apply. |
| OpenAI / Codex | OpenCode documents ChatGPT Plus/Pro OAuth and a separate API-key option. This is not permission to reuse arbitrary Codex credential files. |
| Anthropic / Claude | Use supported Anthropic API credentials. The current provider documentation warns that Claude Pro/Max third-party OAuth plugins are prohibited by Anthropic and stopped being bundled in OpenCode 1.3.0. Do not treat Claude subscription portability as supported. |
| xAI / Grok | OpenCode 1.18.29 ships native SuperGrok device-code OAuth as well as API-key authentication. The plan must include Grok API access; do not assume every consumer tier does. |
| Cursor | Direct Cursor Agent support has been removed from Remodr. No native Cursor-subscription login was verified in the inspected OpenCode provider/auth sources. Third-party plugins are not an equivalent supported native capability. |

The [provider documentation](https://opencode.ai/docs/providers/) contains an
outdated Claude OAuth instruction alongside its newer prohibition warning;
the latter and the current shipped implementation must not be ignored.
OpenCode also supports compatible custom endpoints and local model servers.
Availability depends on the remote configuration, not on a model appearing in
Remodr's bundled offline catalogue.

## Initial Herdr-backed integration

Keep the existing topology:

```text
Remodr -> authenticated SSH -> Python bridge -> Herdr-managed OpenCode TUI
                                           -> read-only OpenCode session DB
                                           -> temporary authenticated loopback bootstrap
```

On the remote server, install/configure OpenCode and its provider credentials,
then install Herdr's built-in integration:

```sh
opencode --version
herdr --version
herdr integration install opencode
herdr integration status
```

Herdr 0.8.2 ships integration version 10, including both a server event plugin
and a TUI session-selection plugin. The TUI plugin reports the exact selected
root session through `pane.report_agent_session`, scoped by `HERDR_PANE_ID` and
`HERDR_SOCKET_PATH`; child-session events are separately handled. Keep both
plugins enabled. Do not launch the managed TUI with `--pure`, which disables
external plugins.

Remodr uses the reported session ID, never the newest database row, newest file,
or a cwd-based guess. It does not invent a `ses_` ID: OpenCode's `--session` flag
resumes an existing session. For agents created from Remodr, the bridge starts
an owned temporary OpenCode server on `127.0.0.1` with an ephemeral password,
creates an empty native session through `POST /session` in the verified workspace
directory, stops that server, then launches the TUI with the returned session ID.
This sends no inference prompt and avoids a first-message deadlock at the home
screen. The bootstrap ID is not a substitute for Herdr's native pane report.

The workspace must have an existing, known absolute cwd. The bridge and TUI
must use the same OpenCode data directory. A manually launched home-only TUI
still needs a selected/created session; missing or unverifiable identity must
not become a durable-send target. `OPENCODE_BIN` can select the bridge's bootstrap
executable; configure Herdr's launch environment consistently. Without an override,
the bridge first searches its SSH PATH, then the standard
`~/.opencode/bin/opencode` installer location. Interactive shell PATH configuration
alone may not apply to the noninteractive SSH bridge.

Launch-time models use `--model provider/model`. OpenCode's `--auto` implements
the existing automatic-tool-approval choice, but does not override explicitly
denied permissions. Omitting it preserves the remote OpenCode permission policy;
it does not force every tool to ask. Remodr does not change the user's global
OpenCode configuration or install plugins automatically.

The read adapter supports the pinned SQLite `message`/`part` layout and newer
`session_message` layout, including empty sessions and tool activity. Reads are
transactional and read-only, including live WAL commits; they never migrate or
edit OpenCode's database. Each projection includes the newest 200 stored
messages for that exact session. Synthetic/system/reasoning parts and other
sessions are excluded. The global database mtime is not attributed as per-agent
activity.

By default the database is `$XDG_DATA_HOME/opencode/opencode.db`, falling back
to `~/.local/share/opencode/opencode.db`, including on macOS. `OPENCODE_DB` or
the bridge-specific `REMODR_OPENCODE_DB` can name an explicit database; relative
names resolve below that data directory. Channel-specific/custom paths must be
configured explicitly, not discovered by picking a recent file. In-memory
databases, unsupported schemas and sessions with an active revert are not
silently treated as normal empty history. Older file-based JSON storage is not
implemented. The current database's session model is reported when available.

The phone's Stop action sends **Escape**, OpenCode's default `session_interrupt`
binding. It never sends Ctrl+C to OpenCode: that defaults to `app_exit`. Herdr
0.8.2 accepts both `escape` and `esc`. This phase assumes default TUI keybindings;
customizing `session_interrupt`, or a focused dialog consuming Escape, can prevent
Stop from aborting work. Remodr does not read or rewrite private TUI configuration
and does not yet use the session-specific API abort endpoint.

## Native API integration is the next boundary

OpenCode's [server API](https://opencode.ai/docs/server/) is the better long-term
surface than reimplementing TUI keystrokes or indefinitely tracking private
database migrations. A separate `opencode serve` process is not automatically
the server backing an existing TUI.

Beyond the short-lived empty-session bootstrap, an API-backed phase must
establish a trustworthy mapping of
`device -> OpenCode server -> project/directory -> session`, with explicit
ownership and lifecycle. Prefer a managed loopback server accessed inside the
existing SSH connection. Configure `OPENCODE_SERVER_PASSWORD` (and optionally
`OPENCODE_SERVER_USERNAME`); do not expose an unauthenticated server on
`0.0.0.0`, infer a server from an arbitrary open port, or fetch all credentials
to make discovery work.

| Native interface | Remodr integration opportunity |
| --- | --- |
| `/global/health`, `/doc` | Version/health negotiation and schema validation against the actual deployed server |
| `/provider`, `/config/providers` | Device/project-scoped model selection instead of a maintenance-machine snapshot |
| `/session`, `/session/:id`, `/session/status` | Explicit creation, binding, status, and restoration |
| `/session/:id/message`, `/session/:id/prompt_async` | Typed messages with a provider/model selection per prompt |
| `/event`, `/global/event` | SSE-driven updates with reconnect snapshot reconciliation, not polling-only reads |
| `/session/:id/abort` | Session-specific stop without relying on customized TUI keybindings |
| Question/permission reply endpoints in the deployed `/doc` | Exact request IDs, choices, multi-question replies and explicit permission handling |

Preserve Remodr's stable command IDs, durable local outbox and remote receipts.
An HTTP timeout is not evidence that a prompt was rejected, and accepting a
client-supplied `messageID` does not by itself prove idempotent replay. Verify
deduplication on the actual deployed version before bypassing the existing
delivery ledger. SSE is not assumed to be a durable replay log.

Live OpenCode model switching, native question/permission buttons, account
management from the phone, and API streaming are not claimed by the initial
Herdr/SQLite adapter. Copilot keeps its existing in-chat settings support;
Claude Code and Codex keep their current limitations.

## Sources

- [OpenCode server API](https://opencode.ai/docs/server/) and [provider authentication](https://opencode.ai/docs/providers/)
- [OpenCode CLI](https://opencode.ai/docs/cli/) and [keybindings](https://opencode.ai/docs/keybinds/)
- [OpenCode 1.18.29 SQLite schema](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/core/src/session/sql.ts)
- [OpenCode 1.18.29 session message types](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/schema/src/session-message.ts)
- [OpenCode 1.18.29 database paths](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/core/src/database/database.ts)
- [OpenCode 1.18.29 model discovery](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/cli/cmd/models.ts)
- [OpenCode 1.18.29 xAI subscription authentication](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/plugin/xai.ts)
- [Herdr 0.8.2 TUI session binding](https://github.com/herdrdev/herdr/blob/v0.8.2/src/integration/assets/opencode/herdr-tui-session.js)
- [Herdr 0.8.2 OpenCode event integration](https://github.com/herdrdev/herdr/blob/v0.8.2/src/integration/assets/opencode/herdr-agent-state.js)
