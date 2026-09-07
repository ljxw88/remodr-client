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
    const opencode = { ...copilot, provider: 'opencode', models: [], unavailableReason: 'CLI not installed' };
    expect(modelCatalogueSchema.parse(opencode)).toEqual(opencode);
    expect(modelCatalogueSchema.safeParse({
      ...opencode, updatedAt: '2026-09-05T12:00:00.000Z',
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
    for (const provider of ['copilot', 'claude', 'opencode']) {
      expect(modelCatalogueSchema.safeParse({ ...copilot, provider, models: [model] }).success).toBe(false);
    }
    expect(modelCatalogueSchema.safeParse({
      ...copilot, provider: 'claude', models: [copilot.models[0]],
    }).success).toBe(false);
  });

  it('accepts OpenCode provider/model identifiers but no effort or context flags', () => {
    const model = {
      ...copilot.models[0], id: 'configured-provider/account/model',
      efforts: [], defaultEffort: null, contexts: [],
    };
    const catalogue = { ...copilot, provider: 'opencode', models: [model] };
    expect(modelCatalogueSchema.parse(catalogue).models[0].id).toBe(model.id);
    expect(modelCatalogueSchema.safeParse({
      ...catalogue, models: [{ ...model, efforts: ['low'] }],
    }).success).toBe(false);
    expect(modelCatalogueSchema.safeParse({
      ...catalogue, models: [{ ...model, contexts: copilot.models[0].contexts }],
    }).success).toBe(false);
    expect(modelCatalogueSchema.safeParse({ ...catalogue, provider: 'cursor' }).success).toBe(false);
  });

  it.each([
    'model-only', '/model', 'provider/', 'provider name/model', 'provider/model name',
    'provider:model/name', 'provider/model\tname', 'provider/model\u0000name',
    'provider/model\u007fname',
  ])('rejects invalid OpenCode selector %j', (id) => {
    expect(modelCatalogueSchema.safeParse({
      ...copilot, provider: 'opencode',
      models: [{ ...copilot.models[0], id, efforts: [], defaultEffort: null, contexts: [] }],
    }).success).toBe(false);
  });
});
