# Model catalogues

Model data is bundled in separate JSON files under
[`src/domain/model-catalogues`](../src/domain/model-catalogues/):
`opencode.json`, `copilot.json`, `claude.json`, and `codex.json`. The app does not
query provider services from the phone. Refresh these files on a maintenance
machine, review the diff, and ship the updated app.

## Refreshing

Run the executable shell script to refresh all four providers:

```sh
./scripts/refresh-models.sh
```

It resolves paths relative to itself, so it also works when invoked from
another directory. It forwards options such as `--provider copilot,codex`,
`--dry-run`, and `--check` to the same refresh implementation.

Use Node.js 22.18+ (or Node.js 24+) and the project's installed dependencies.
The maintenance command uses Node's native TypeScript support to share the
app's Zod schema; it does not need a separate transpiler.

```sh
npm run models:refresh
npm run models:refresh -- --provider copilot,codex
npm run models:refresh -- --provider opencode --dry-run
npm run models:refresh -- --check
```

No inference prompts are sent. Account-aware discovery requires the relevant
CLI to be installed and authenticated on the maintenance machine. Discovery
is not proof that a different remote host, account, plan, or CLI version can
run the same models. Leaving the app's selection on **Auto** still omits all
tuning flags.

`--dry-run` discovers and validates without writing. `--check` only validates
the checked-in snapshots, without network access or CLI discovery. All
selected providers must be fetched and validated before any writes begin;
each file is replaced through a same-directory temporary file and rename.
Discovery, authentication, malformed output, and unsupported config values
fail the command instead of replacing a usable catalogue with an empty list.
Select one provider explicitly when the other CLIs are unavailable.

## Discovery sources and prerequisites

| Provider | Source | Details and limitations |
| --- | --- | --- |
| OpenCode | `opencode models` | Configured `provider/model` selectors, including nested model IDs. Uses the CLI's own provider configuration; no inference prompt or credential-file reads by Remodr. |
| Copilot | `copilot --headless --stdio --no-auto-update`, `connect` then `models.list` | Native model names, efforts, limits, policy and billing/context metadata. Auto and disabled entries are excluded. |
| Codex | `codex app-server`, `model/list` with pagination | Native model choices and effort defaults; numeric context metadata is joined by exact ID from the installed version's official release catalogue. |
| Claude Code | Native stream-JSON `initialize.models`, the protocol behind Agent SDK `supportedModels()` | Picker aliases, resolved IDs and efforts. Initializes a subprocess, but sends no user message. Hooks/MCP are disabled and sessions are not persisted. |

Executable overrides are `OPENCODE_BIN`, `COPILOT_BIN`, `CLAUDE_BIN`, and
`CODEX_BIN`. Values
must be executable paths/names, not shell command strings. Authentication is
handled by the native CLI; the script never reads credential files. Child stdin
is closed and commands have timeouts. Native CLI initialization may load configured
plugins and consult provider services; this is not a guarantee of zero startup
effects. OpenCode discovery does not prove that each listed model is authorized
for inference, nor that another server has the same configuration.

Copilot pricing `maxPromptTokens` (and its older `contextMax` spelling) are
**prompt budgets**, not total context windows. Context-tier labels add the
reported output allowance. When either number is missing, the script leaves
the tier choices unknown rather than guessing.

Codex's `model/list` may use cached or bundled metadata if a network refresh
is unavailable. Its snapshot records that limitation. The supplemental
`rust-v<installed-version>` repository URL is version-pinned; missing releases
fail explicitly rather than silently substituting `main`. `context_window`,
`max_context_window`, and auto-compaction thresholds are distinct settings;
only the first becomes `limits.contextTokens`.

Claude Code's native model list currently does not expose numeric context
limits or default effort. Those fields remain `null`; supported efforts and
extended-context IDs such as `opus[1m]` are still preserved. An Anthropic API
model list is deliberately not substituted for a Claude Code account list.

The bundled OpenCode catalogue was discovered from the installed CLI, not
invented from model-family names. It is a maintenance-machine snapshot, not
proof of remote account availability. Auto uses the remote OpenCode configuration.
An installation without a discovered catalogue can use an explicit
`unavailableReason` and null timestamp rather than fabricated models.
To refresh the snapshot after configuring OpenCode:

```sh
npm run models:refresh -- --provider opencode
```

The OpenCode parser requires one `provider/model` selector per line and rejects
duplicate IDs or unrecognized output rather than publishing a partial list.
The format is verified against [OpenCode 1.18.29's models command](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/cli/cmd/models.ts).
It deliberately does not use `--verbose` or persist arbitrary provider metadata:
custom endpoints, headers and options need not be bundled in the mobile app.
IDs are kept intact, for example `openrouter/vendor/model`; no model-name
suffix is converted into a generic reasoning flag. Numeric limits remain unknown.

Upstream contracts:
[Copilot SDK](https://github.com/github/copilot-sdk),
[Codex app server](https://github.com/openai/codex/tree/main/codex-rs/app-server),
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/typescript),
[OpenCode CLI](https://opencode.ai/docs/cli/), and
[OpenCode providers](https://opencode.ai/docs/providers/).

## Data contract

[`model-catalogue-schema.ts`](../src/domain/model-catalogue-schema.ts) is shared
by the app and the refresh script. Each file records its provider, schema
version, refresh timestamp, sources, limitations, and models. Each model stores:

| Field | Meaning |
| --- | --- |
| `id`, `label` | CLI model selector and display name |
| `efforts` | Reasoning settings the app can actually send to that CLI |
| `contexts` | Selectable CLI context tiers, not an inferred model-family limit |
| `limits` | Reported token limits; `null` means not exposed by the source |
| `defaultEffort` | Reported default, or `null` when unknown |
| `details` | Provider-specific discovery metadata, including capabilities not exposed as app controls |

An empty `efforts` or `contexts` array means no verified control is offered.
It does not imply a model cannot reason or has no context limit. In
particular, a token capacity is not a portable `--context` flag. Provider
variants encoded in model IDs remain separate model choices.

New effort names require updating the shared schema, UI label, and bridge
vocabulary before they can be offered. This prevents a remote metadata change
from silently introducing arguments the app/bridge cannot handle.

Behavior tests use a frozen fixture rather than assuming a live vendor will
keep offering a particular model forever. `--check` validates the actual
shipped snapshots with the same schema used at app startup.

## Launching versus changing a running agent

All four providers support model selection at creation. Copilot, Codex, and
Claude Code also accept their verified reasoning settings. OpenCode model selectors
include the upstream provider namespace; no generic effort/context flags are invented.

Live **Model Settings** remain Copilot-only. Its session log, model-switch,
and resume behavior have a dedicated bridge adapter; merely adding a JSON
catalogue must not send Copilot commands to another running CLI. OpenCode's
native per-session model controls require the future API integration described
in [OpenCode integration](opencode-integration.md).

## Adding a provider

Add a source adapter in `scripts/model-sources.cjs`, its JSON snapshot and
static app import, and provider/schema entries. Implement bridge behavior in a
package under `modules/remote-core/bridge/remodr_bridge/providers/` and register
its adapter in that directory's `__init__.py`; the runtime bundle includes the
new module automatically. Add fixtures for the discovery format and tests for its CLI
arguments. Do not copy another provider's context or effort settings even if
the model IDs look similar.
