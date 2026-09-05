const { normalizeCopilot, normalizeCodex, normalizeClaude, parseCursorModels, assertCursorAuthenticated } = require('../../scripts/model-sources.cjs');
const cursorFooter = "Tip: use --model <id> (or /model <id> in interactive mode) to switch. Parameterized models also accept quoted overrides, e.g. --model 'claude-opus-4-8[context=1m,effort=high,fast=false]'.";
const cursorOutput = (rows: string) => `Available models\n\n${rows}\n\n${cursorFooter}\n`;

describe('vendor model normalization', () => {
  it('uses Copilot prompt budgets plus output capacity for tier labels', () => {
    const raw = {
      id: 'example', name: 'Example',
      supportedReasoningEfforts: ['low', 'high'],
      defaultReasoningEffort: 'low',
      capabilities: { limits: { max_context_window_tokens: 1000000, max_output_tokens: 64000 } },
      billing: { tokenPrices: { maxPromptTokens: 200000, longContext: { maxPromptTokens: 936000 } } },
    };
    expect(normalizeCopilot([raw])[0]).toMatchObject({
      id: 'example', efforts: ['low', 'high'], defaultEffort: 'low',
      contexts: [{ tier: 'default', size: '264K' }, { tier: 'long_context', size: '1M' }],
      limits: { contextTokens: 1000000, outputTokens: 64000 },
      details: raw,
    });
  });

  it('does not invent Copilot tiers from a context limit or an unknown output reserve', () => {
    for (const limits of [{ max_context_window_tokens: 1000000 }, { max_output_tokens: 0 }]) {
      expect(normalizeCopilot([{
        id: 'one', name: 'One', capabilities: { limits },
        billing: { tokenPrices: { contextMax: 200000, longContext: { contextMax: 936000 } } },
      }])[0].contexts).toEqual([]);
    }
    expect(normalizeCopilot([
      { id: 'auto', name: 'Auto' },
      { id: 'blocked', name: 'Blocked', policy: { state: 'disabled' } },
    ])).toEqual([]);
  });

  it('keeps Codex native efforts/defaults and joins context only by exact wire ID', () => {
    const native = {
      id: 'picker-id', model: 'wire-id', displayName: 'Wire Model',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }],
      defaultReasoningEffort: 'ultra', serviceTiers: [{ id: 'priority' }],
    };
    const result = normalizeCodex([native], [{
      slug: 'wire-id', context_window: 272000, max_context_window: 1000000,
      base_instructions: 'Do not ship this', model_messages: { instructions_template: 'Or this' },
    }])[0];
    expect(result).toMatchObject({
      id: 'wire-id', efforts: ['low', 'ultra'], defaultEffort: 'ultra', contexts: [],
      limits: { contextTokens: 272000, outputTokens: null },
      details: { native, bundledRelease: { max_context_window: 1000000 } },
    });
    expect(result.details.bundledRelease).not.toHaveProperty('base_instructions');
    expect(result.details.bundledRelease).not.toHaveProperty('model_messages');
    expect(normalizeCodex([native], [{ slug: 'picker-id', context_window: 1000000 }])[0].limits.contextTokens).toBeNull();
  });

  it('keeps Claude picker aliases separate from resolved IDs and unknown limits/defaults', () => {
    const raw = {
      value: 'opus[1m]', resolvedModel: 'claude-opus-example[1m]', displayName: 'Opus',
      supportedEffortLevels: ['high', 'max'], supportsEffort: true, supportsFastMode: true,
    };
    expect(normalizeClaude([raw])[0]).toMatchObject({
      id: 'opus[1m]', efforts: ['high', 'max'], contexts: [],
      defaultEffort: null, limits: { contextTokens: null, outputTokens: null },
      details: raw,
    });
    expect(normalizeClaude([{ ...raw, supportsEffort: false }])[0].efforts).toEqual([]);
  });

  it('parses Cursor model IDs as opaque selectors rather than inferring flags from suffixes', () => {
    const models = parseCursorModels(cursorOutput('auto - Auto\n\x1b[32msonnet-thinking\x1b[0m - Sonnet Thinking (current, default)\nopus-max - Opus Max\nunnamed-model\nopus[context=1m,effort=high] - Opus (current)'));
    expect(models.map((model: { id: string }) => model.id)).toEqual([
      'sonnet-thinking', 'opus-max', 'unnamed-model', 'opus[context=1m,effort=high]',
    ]);
    expect(models[0]).toMatchObject({ label: 'Sonnet Thinking', efforts: [], contexts: [] });
    expect(models[2].label).toBe('unnamed-model');
    expect(() => parseCursorModels('Please log in to continue')).toThrow('Unrecognized');
    expect(() => parseCursorModels(cursorOutput('id - Valid\nunknown format'))).toThrow('Unrecognized');
    expect(() => parseCursorModels(cursorOutput('auto - Auto'))).toThrow('no selectable models');
    expect(() => parseCursorModels('No models available for this account.')).toThrow('no selectable models');
    expect(() => parseCursorModels(cursorOutput('same - Name\nsame - Other'))).toThrow('Duplicate');
    expect(() => parseCursorModels('Available models\nid - Name\nTip: use --model')).toThrow('incomplete');
    expect(() => parseCursorModels(`id - Name\n${cursorFooter}`)).toThrow('incomplete');
  });

  it('refuses malformed responses instead of treating them as empty catalogues', () => {
    expect(() => normalizeCopilot({ models: [] })).toThrow();
    expect(() => normalizeCopilot([{ id: 'x', name: 'X', supportedReasoningEfforts: 'high' }])).toThrow();
    expect(() => normalizeCodex([{ model: 'x' }], [])).toThrow();
    expect(() => normalizeClaude([{ id: 'x', displayName: 'X' }])).toThrow();
  });

  it('checks Cursor auth JSON rather than trusting a zero status exit code', () => {
    expect(() => assertCursorAuthenticated(JSON.stringify({
      status: 'authenticated', isAuthenticated: true,
    }))).not.toThrow();
    for (const state of [
      { status: 'unauthenticated', isAuthenticated: false },
      { status: 'partially-authenticated', isAuthenticated: false },
      { status: 'authenticated', isAuthenticated: true, message: 'Logged in (unable to fetch user details)' },
    ]) {
      expect(() => assertCursorAuthenticated(JSON.stringify(state))).toThrow('authentication is unverified');
    }
  });
});
