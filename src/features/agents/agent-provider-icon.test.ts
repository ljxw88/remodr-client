import { providerBrandColor } from './agent-provider-icon';

describe('agent-provider-icon', () => {
  it('returns distinct brand colors for each provider', () => {
    expect(providerBrandColor('copilot')).toBe('#8957E5');
    expect(providerBrandColor('claude')).toBe('#D97757');
    expect(providerBrandColor('codex')).toBe('#10A37F');
    expect(providerBrandColor('opencode')).toBe('#06B6D4');
    expect(providerBrandColor('unknown')).toBe('#94A3B8');
  });
});
