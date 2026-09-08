const { z } = require('zod');
const { modelCatalogueSchema } = require('../src/domain/model-catalogue-schema.ts');
const { openRpc } = require('./model-rpc.cjs');

const nonempty = z.string().min(1);
const positive = (value) => Number.isInteger(value) && value > 0 ? value : null;
const modelsArray = (schema) => z.array(schema).min(1);

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

async function fetchCopilot() {
  const command = process.env.COPILOT_BIN || 'copilot';
  const rpc = openRpc(command, ['--headless', '--stdio', '--no-auto-update']);
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

const adapters = { copilot: fetchCopilot };
async function discover(provider) {
  if (!Object.hasOwn(adapters, provider)) throw new Error(`Unsupported provider: ${provider}`);
  return adapters[provider]();
}

module.exports = { discover, normalizeCopilot };
