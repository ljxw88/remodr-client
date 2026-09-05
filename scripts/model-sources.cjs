const { execFile } = require('node:child_process');
const { Buffer } = require('node:buffer');
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
// Renderer verified in Cursor CLI 2026.09.02-c22c1a3, src/commands/models.ts.
const CURSOR_MODELS_FOOTER = "Tip: use --model <id> (or /model <id> in interactive mode) to switch. Parameterized models also accept quoted overrides, e.g. --model 'claude-opus-4-8[context=1m,effort=high,fast=false]'.";

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

function parseCursorModels(text) {
  const models = [];
  // `models` is a text command; --output-format applies to inference, not discovery.
  const lines = stripVTControlCharacters(text).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (lines.length === 1 && lines[0] === 'No models available for this account.') {
    throw new Error('Cursor returned no selectable models');
  }
  if (lines[0] !== 'Available models' || lines.at(-1) !== CURSOR_MODELS_FOOTER) {
    throw new Error('Unrecognized or incomplete Cursor models output; refusing a partial catalogue. See docs/model-catalogues.md.');
  }
  const seen = new Set();
  for (const line of lines.slice(1, -1)) {
    const unannotated = line.replace(/ \((?:current|default|current, default)\)$/, '');
    const match = /^(\S+)(?: - (.+))?$/.exec(unannotated);
    if (!match) throw new Error('Unrecognized Cursor models output; refusing a partial catalogue. See docs/model-catalogues.md.');
    if (seen.has(match[1])) throw new Error(`Duplicate Cursor model ID: ${match[1]}`);
    seen.add(match[1]);
    models.push(base(match[1], match[2] || match[1], { cliLabel: line }));
  }
  const selectable = models.filter((model) => model.id !== 'auto');
  if (!selectable.length) throw new Error('Cursor returned no selectable models');
  return selectable;
}

function assertCursorAuthenticated(text) {
  const status = z.object({
    status: nonempty,
    isAuthenticated: z.boolean(),
    message: z.string().optional(),
  }).parse(JSON.parse(text));
  if (status.status !== 'authenticated' || !status.isAuthenticated
    || status.message === 'Logged in (unable to fetch user details)') {
    throw new Error('Cursor authentication is unverified. Run agent login before refreshing, or provide CURSOR_API_KEY.');
  }
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

async function fetchCursor() {
  const command = process.env.CURSOR_AGENT_BIN || 'agent';
  let api;
  if (process.env.CURSOR_API_KEY) {
    const url = 'https://api.cursor.com/v1/models';
    api = z.object({
      items: z.array(z.object({
        id: nonempty, aliases: z.array(nonempty).optional(),
      }).passthrough()),
    }).parse(await fetchJson(url, {
      Authorization: `Basic ${Buffer.from(`${process.env.CURSOR_API_KEY}:`).toString('base64')}`,
    }));
  } else {
    // Status exits zero even when logged out. Its JSON must affirm authentication.
    assertCursorAuthenticated(await commandOutput(command, ['status', '--format', 'json']));
  }
  const models = parseCursorModels(await commandOutput(command, ['models']));
  const sources = [{ kind: 'cli', location: 'Cursor Agent: agent models' }];
  const notes = ['Cursor CLI model IDs encode selectable variants; no generic effort or context flags are invented.'];
  if (api) {
    for (const model of models) {
      const exact = api.items.find((item) => item.id === model.id || item.aliases?.includes(model.id));
      if (exact) model.details.sdkApi = exact;
    }
    sources.push({ kind: 'api', location: 'https://api.cursor.com/v1/models' });
    notes.push('SDK/API parameter and variant details are attached only to exact CLI IDs or explicit aliases; cloud metadata is not treated as CLI account availability.');
  } else {
    notes.push('Set CURSOR_API_KEY to enrich exact CLI matches with official SDK/API parameters and variants. CLI text does not expose numeric context limits.');
  }
  return catalogue('cursor', models, sources, notes);
}

const adapters = { copilot: fetchCopilot, codex: fetchCodex, claude: fetchClaude, cursor: fetchCursor };
async function discover(provider) {
  if (!Object.hasOwn(adapters, provider)) throw new Error(`Unsupported provider: ${provider}`);
  return adapters[provider]();
}

module.exports = { discover, normalizeCopilot, normalizeCodex, normalizeClaude, parseCursorModels, assertCursorAuthenticated };
