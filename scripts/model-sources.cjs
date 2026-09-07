const { execFile } = require('node:child_process');
const { promisify, stripVTControlCharacters } = require('node:util');
const { tmpdir } = require('node:os');
const { z } = require('zod');
const { modelCatalogueSchema } = require('../src/domain/model-catalogue-schema.ts');
const { openRpc } = require('./model-rpc.cjs');

const exec = promisify(execFile);
const nonempty = z.string().min(1);
const positive = (value) => Number.isInteger(value) && value > 0 ? value : null;
const modelsArray = (schema) => z.array(schema).min(1);
const CODEX_NOTES = 'Native model/list may use the CLI cache or bundled fallback; discovery is not proof of a fresh network response or account entitlement.';

function base(id, label, details) {
  return {
    id, label, efforts: [], contexts: [],
    limits: { contextTokens: null, outputTokens: null },
    defaultEffort: null, details,
  };
}

function catalogue(provider, models, sources, notes) {
  return modelCatalogueSchema.parse({
    schemaVersion: 1, provider, updatedAt: new Date().toISOString(), sources, notes, models,
  });
}

function tokenLabel(tokens) {
  return tokens >= 1000000 ? `${tokens / 1000000}M` : `${tokens / 1000}K`;
}

function normalizeCopilot(raw) {
  const input = modelsArray(z.object({
    id: nonempty, name: nonempty,
    supportedReasoningEfforts: z.array(nonempty).optional(),
    defaultReasoningEffort: nonempty.optional(),
    supportedContextTiers: z.array(nonempty).optional(),
  }).passthrough()).parse(raw);
  return input.filter((model) => model.id !== 'auto' && model.policy?.state !== 'disabled').map((model) => {
    const result = base(model.id, model.name, model);
    result.efforts = model.supportedReasoningEfforts ?? [];
    result.defaultEffort = model.defaultReasoningEffort ?? null;
    const limits = model.capabilities?.limits;
    const output = positive(limits?.max_output_tokens);
    result.limits = { contextTokens: positive(limits?.max_context_window_tokens), outputTokens: output };
    const prices = model.billing?.tokenPrices;
    const standard = positive(prices?.maxPromptTokens ?? prices?.contextMax);
    const long = positive(prices?.longContext?.maxPromptTokens ?? prices?.longContext?.contextMax);
    const tiers = model.supportedContextTiers;
    // Copilot's pricing fields are prompt budgets; output capacity completes the window.
    if (standard && long && output && (!tiers || (tiers.includes('default') && tiers.includes('long_context')))) {
      result.contexts = [
        { tier: 'default', size: tokenLabel(standard + output) },
        { tier: 'long_context', size: tokenLabel(long + output) },
      ];
    }
    return result;
  });
}

function normalizeCodex(raw, bundled) {
  const input = modelsArray(z.object({
    id: nonempty, model: nonempty, displayName: nonempty,
    supportedReasoningEfforts: z.array(z.object({ reasoningEffort: nonempty }).passthrough()),
    defaultReasoningEffort: nonempty.nullable().optional(),
    hidden: z.boolean().optional(),
  }).passthrough()).parse(raw);
  return input.filter((model) => !model.hidden).map((model) => {
    const entry = bundled.find((item) => item.slug === model.model);
    // Model instructions are not catalog configuration and need not be bundled in the app.
    const metadata = entry && Object.fromEntries(Object.entries(entry).filter(([key]) =>
      !['base_instructions', 'model_messages'].includes(key)));
    const result = base(model.model, model.displayName, {
      native: model, ...(metadata ? { bundledRelease: metadata } : {}),
    });
    result.efforts = model.supportedReasoningEfforts.map((option) => option.reasoningEffort);
    result.defaultEffort = model.defaultReasoningEffort ?? null;
    result.limits.contextTokens = positive(entry?.context_window);
    return result;
  });
}

function normalizeClaude(raw) {
  return modelsArray(z.object({
    value: nonempty, displayName: nonempty,
    supportsEffort: z.boolean().optional(),
    supportedEffortLevels: z.array(nonempty).optional(),
  }).passthrough()).parse(raw).filter((model) => model.value !== 'default').map((model) => {
    const result = base(model.value, model.displayName, model);
    result.efforts = model.supportsEffort === false ? [] : model.supportedEffortLevels ?? [];
    return result;
  });
}

function parseOpenCodeModels(text) {
  // OpenCode 1.18.29's models command emits one provider/model selector per line.
  // Avoid --verbose: custom provider metadata may include private configuration.
  const lines = stripVTControlCharacters(text).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (!lines.length) throw new Error('OpenCode returned no selectable models');
  const seen = new Set();
  return lines.map((id) => {
    const match = /^([A-Za-z0-9._-]+)\/([^\s\x00-\x1f\x7f]+)$/.exec(id);
    if (!match) throw new Error('Unrecognized OpenCode models output; refusing a partial catalogue.');
    if (seen.has(id)) throw new Error(`Duplicate OpenCode model ID: ${id}`);
    seen.add(id);
    return base(id, id, { providerID: match[1], modelID: match[2] });
  });
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Model metadata HTTP ${response.status}: ${new URL(url).origin}`);
  return response.json();
}

async function commandOutput(command, args) {
  try {
    const running = exec(command, args, {
      cwd: tmpdir(), timeout: 60000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    });
    running.child.stdin?.end();
    return (await running).stdout;
  } catch (error) {
    throw new Error(`${command} ${args.join(' ')} failed (${error.code ?? 'timeout'}). Install/authenticate the CLI; no catalogue was refreshed.`);
  }
}

async function fetchCopilot() {
  const command = process.env.COPILOT_BIN || 'copilot';
  const rpc = openRpc(command, ['--headless', '--stdio', '--no-auto-update'], 'headers');
  try {
    await rpc.request('connect', { supportedTaskKinds: ['agent', 'client', 'shell'] });
    const result = await rpc.request('models.list');
    return catalogue('copilot', normalizeCopilot(result.models), [
      { kind: 'cli', location: 'copilot --headless --stdio --no-auto-update: connect / models.list' },
    ], ['Account/policy-scoped Copilot CLI snapshot; Auto is represented by the app, not a duplicate model row.']);
  } finally {
    rpc.close();
  }
}

async function fetchCodex() {
  const command = process.env.CODEX_BIN || 'codex';
  const version = (await commandOutput(command, ['--version'])).trim();
  const match = /^codex-cli (\d+\.\d+\.\d+)$/.exec(version);
  if (!match) throw new Error(`Unsupported Codex version format: ${version}`);
  const url = `https://raw.githubusercontent.com/openai/codex/rust-v${match[1]}/codex-rs/models-manager/models.json`;
  const bundled = z.object({ models: modelsArray(z.object({ slug: nonempty }).passthrough()) }).parse(await fetchJson(url));
  const rpc = openRpc(command, ['app-server', '--listen', 'stdio://']);
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'remodr-model-catalogue', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    rpc.notify('initialized');
    const models = [];
    let cursor = null;
    const seen = new Set();
    do {
      const page = z.object({
        data: z.array(z.unknown()), nextCursor: nonempty.nullable(),
      }).parse(await rpc.request('model/list', { limit: 100, includeHidden: false, cursor }));
      models.push(...page.data);
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('Codex repeated a pagination cursor');
      seen.add(cursor);
    } while (cursor);
    return catalogue('codex', normalizeCodex(models, bundled.models), [
      { kind: 'cli', location: `${version}: app-server / model/list` },
      { kind: 'repository', location: url },
    ], [CODEX_NOTES, 'Context limits come from the matching CLI release, not live account configuration. Maximum overrides and compaction thresholds remain in details, not context-tier controls.']);
  } finally {
    rpc.close();
  }
}

async function fetchClaude() {
  const command = process.env.CLAUDE_BIN || 'claude';
  const rpc = openRpc(command, [
    '--output-format', 'stream-json', '--verbose', '--input-format', 'stream-json',
    '--no-session-persistence', '--settings', '{"disableAllHooks":true}',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '',
  ], 'claude', 60000, { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' });
  try {
    const result = await rpc.request('initialize');
    return catalogue('claude', normalizeClaude(result.models), [
      { kind: 'cli', location: 'claude stream-json initialize.models (Agent SDK supportedModels protocol)' },
    ], [
      'Initializes a nonpersistent Claude Code subprocess without a user prompt; hooks and MCP servers are disabled for discovery.',
      'Native picker aliases/resolved IDs and effort levels are preserved. The initialization response does not expose numeric context limits or default effort; these remain null.',
      'Remote account, provider and managed model restrictions can differ from this maintenance machine.',
    ]);
  } finally {
    rpc.close();
  }
}

async function fetchOpenCode() {
  const command = process.env.OPENCODE_BIN || 'opencode';
  const models = parseOpenCodeModels(await commandOutput(command, ['models']));
  return catalogue('opencode', models, [
    { kind: 'cli', location: 'opencode models (provider/model selectors)' },
  ], [
    'Configured OpenCode provider/model selectors from this maintenance machine; remote project configuration, credentials and account entitlement can differ.',
    'No inference prompt is sent. OpenCode manages authentication and plugin initialization; Remodr does not read credential files or persist verbose provider configuration.',
    'Numeric limits and generic effort/context controls are not inferred. Auto uses the remote OpenCode configuration.',
  ]);
}

const adapters = { opencode: fetchOpenCode, copilot: fetchCopilot, codex: fetchCodex, claude: fetchClaude };
async function discover(provider) {
  if (!Object.hasOwn(adapters, provider)) throw new Error(`Unsupported provider: ${provider}`);
  return adapters[provider]();
}

module.exports = { discover, normalizeCopilot, normalizeCodex, normalizeClaude, parseOpenCodeModels };
