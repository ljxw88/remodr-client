import { modelCatalogueSchema } from './model-catalogue-schema';
import copilot from './__fixtures__/copilot.json';

describe('model catalogue validation', () => {
  it('validates the migrated catalogue without changing it', () => {
    expect(modelCatalogueSchema.parse(copilot)).toEqual(copilot);
  });

  it('rejects empty catalogs and duplicate IDs before they replace usable data', () => {
    expect(modelCatalogueSchema.safeParse({ ...copilot, models: [] }).success).toBe(false);
    expect(modelCatalogueSchema.safeParse({
      ...copilot, models: [copilot.models[0], copilot.models[0]],
    }).success).toBe(false);
  });

  it('allows a clearly marked initial unavailable catalogue without claiming a refresh', () => {
    const cursor = { ...copilot, provider: 'cursor', models: [], unavailableReason: 'CLI not installed' };
    expect(modelCatalogueSchema.parse(cursor)).toEqual(cursor);
    expect(modelCatalogueSchema.safeParse({
      ...cursor, updatedAt: '2026-09-05T12:00:00.000Z',
    }).success).toBe(false);
  });

  it('rejects unknown flags, unsupported defaults, and ambiguous context choices', () => {
    for (const overrides of [
      { efforts: ['superhigh'] },
      { efforts: ['high'], defaultEffort: 'low' },
      { contexts: [{ tier: 'default', size: '200K' }] },
      { contexts: [{ tier: 'default', size: '200K' }, { tier: 'default', size: '1M' }] },
    ]) {
      expect(modelCatalogueSchema.safeParse({
        ...copilot, models: [{ ...copilot.models[0], ...overrides }],
      }).success).toBe(false);
    }
  });

  it('preserves unexposed vendor details and explicitly unknown limits', () => {
    const model = {
      ...copilot.models[0], limits: { contextTokens: null, outputTokens: null },
      details: { supportsImages: true, futureCapability: { supported: true } },
    };
    expect(modelCatalogueSchema.parse({ ...copilot, models: [model] }).models[0]).toEqual(model);
  });

  it('rejects cross-provider flags the bridge cannot send', () => {
    const model = { ...copilot.models[0], efforts: ['ultra'], contexts: [] };
    expect(modelCatalogueSchema.safeParse({ ...copilot, provider: 'codex', models: [model] }).success).toBe(true);
    for (const provider of ['copilot', 'claude', 'cursor']) {
      expect(modelCatalogueSchema.safeParse({ ...copilot, provider, models: [model] }).success).toBe(false);
    }
    expect(modelCatalogueSchema.safeParse({
      ...copilot, provider: 'claude', models: [copilot.models[0]],
    }).success).toBe(false);
  });
});
