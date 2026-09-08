const { normalizeCopilot } = require('../../scripts/model-sources.cjs');

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

  it('refuses malformed responses instead of treating them as empty catalogues', () => {
    expect(() => normalizeCopilot({ models: [] })).toThrow();
    expect(() => normalizeCopilot([{ id: 'x', name: 'X', supportedReasoningEfforts: 'high' }])).toThrow();
  });

});
