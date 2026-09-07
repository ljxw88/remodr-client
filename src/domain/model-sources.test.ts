const { normalizeCopilot, normalizeCodex, normalizeClaude, parseOpenCodeModels } = require('../../scripts/model-sources.cjs');

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

  it('preserves OpenCode provider/model namespaces without inventing flags or exposing metadata', () => {
    const models = parseOpenCodeModels('\x1b[32mopenai/example\x1b[0m\r\nanthropic/example\nopenrouter/vendor/model\n');
    expect(models.map((model: { id: string }) => model.id)).toEqual([
      'openai/example', 'anthropic/example', 'openrouter/vendor/model',
    ]);
    expect(models[0]).toMatchObject({
      label: 'openai/example', efforts: [], contexts: [],
      limits: { contextTokens: null, outputTokens: null },
      details: { providerID: 'openai', modelID: 'example' },
    });
    expect(models[2].details).toEqual({ providerID: 'openrouter', modelID: 'vendor/model' });
    for (const bad of ['Please log in', 'provider/', '/model', 'provider/model extra', 'provider/model\n{"apiKey":"not-a-real-key"}']) {
      expect(() => parseOpenCodeModels(bad)).toThrow('Unrecognized');
    }
    expect(() => parseOpenCodeModels('')).toThrow('no selectable models');
    expect(() => parseOpenCodeModels('p/m\np/m\n')).toThrow('Duplicate');
  });

  it('refuses malformed responses instead of treating them as empty catalogues', () => {
    expect(() => normalizeCopilot({ models: [] })).toThrow();
    expect(() => normalizeCopilot([{ id: 'x', name: 'X', supportedReasoningEfforts: 'high' }])).toThrow();
    expect(() => normalizeCodex([{ model: 'x' }], [])).toThrow();
    expect(() => normalizeClaude([{ id: 'x', displayName: 'X' }])).toThrow();
  });

});
