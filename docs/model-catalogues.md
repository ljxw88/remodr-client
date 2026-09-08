# Model sources

OpenCode and GitHub Copilot obtain model choices differently.

## OpenCode: fetch from the selected server

OpenCode model choices are fetched from the selected remote server in the
selected space's directory. Open **New Agent -> Model** to load the effective
models, or use **Refresh from server** after changing authentication or project
configuration. No app update or bundled OpenCode model snapshot is required.

Configure model-provider accounts in OpenCode itself:

```text
/connect
```

Use that workflow for ChatGPT/OpenAI, Anthropic, GitHub Copilot, or another
provider supported by the remote OpenCode installation. Remodr does not copy
credentials to the phone and does not launch standalone Codex or Claude Code
agents.

The `opencode.models` bridge endpoint accepts a workspace ID and a refresh flag,
not an arbitrary directory or shell command from the phone. It runs:

```sh
opencode models
opencode models --refresh
```

The command executes in the verified workspace so project `opencode.json` /
`opencode.jsonc` settings, custom providers, plugins, and model allow/deny lists
apply. The bridge rechecks the workspace after discovery, returns only bounded
`provider/model` selectors, and never forwards verbose provider metadata,
credentials, or stderr.

OpenCode can silently fall back to cached catalogue data when an upstream
refresh or provider-specific model request fails. A fetched model therefore
means "available in this OpenCode configuration," not guaranteed account
entitlement, quota, regional availability, or a successful network refresh.
**Auto** remains available for OpenCode's native default.

A failed fetch is shown explicitly and never replaced with another server's
list. Changing devices or OpenCode spaces clears the selected model because
project configuration can differ. If a successful refresh removes a selected
model, the draft keeps it visible but blocks creation until the user chooses
another model or Auto.

## GitHub Copilot: bundled reviewed catalogue

Copilot's reviewed model metadata is stored in
[`src/domain/model-catalogues/copilot.json`](../src/domain/model-catalogues/copilot.json).
Refresh and validate it on a maintenance machine:

```sh
npm run models:refresh
npm run models:refresh -- --provider copilot --dry-run
npm run models:refresh -- --check
```

The refresh uses `copilot --headless --stdio --no-auto-update`, then
`connect` and `models.list`. It sends no inference prompt. The resulting
catalogue includes native names, supported reasoning efforts, limits, policy,
and context metadata. Auto and disabled entries are excluded.

Use Node.js 22.18+ (or Node.js 24+) and the project's installed dependencies.
`--dry-run` discovers and validates without writing. `--check` validates the
checked-in snapshot without CLI discovery. Discovery, authentication, malformed
output, and unsupported values fail instead of replacing a usable catalogue.
`COPILOT_BIN` can select the executable path/name.

Copilot pricing `maxPromptTokens` (and its older `contextMax` spelling) is a
prompt budget, not a total context window. Context labels add the reported
output allowance. Missing values remain unknown rather than being guessed.

## Data contracts

[`model-catalogue-schema.ts`](../src/domain/model-catalogue-schema.ts) validates
the bundled Copilot catalogue. Each model records:

| Field | Meaning |
| --- | --- |
| `id`, `label` | CLI model selector and display name |
| `efforts` | Reasoning settings the bridge can send |
| `contexts` | Selectable Copilot context tiers |
| `limits` | Reported token limits; `null` means unknown |
| `defaultEffort` | Reported default, or `null` |
| `details` | Reviewed provider metadata not exposed as generic flags |

[`opencode-models.ts`](../src/domain/opencode-models.ts) independently validates
the remote OpenCode response. It accepts selectors only; it does not treat
arbitrary OpenCode metadata as a portable reasoning/context contract. Reasoning
variants are read later from the active OpenCode TUI's native variant chooser.

Live **Model Settings** support Copilot tuning and OpenCode reasoning variants.
Changing a running OpenCode agent's model remains an OpenCode operation.

Upstream contracts:
[Copilot SDK](https://github.com/github/copilot-sdk),
[OpenCode CLI](https://opencode.ai/docs/cli/), and
[OpenCode providers](https://opencode.ai/docs/providers/).
