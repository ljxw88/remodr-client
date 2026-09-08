import { retuningUnavailableReason, supportsRetuning } from './agent-capabilities';
import { agentCapabilitiesSchema } from './herdr';

describe('live retuning capabilities', () => {
  it.each([
    [true, true], [false, false], [undefined, true],
  ] as const)('resolves Copilot remote support %s as %s', (remote, supported) => {
    const capabilities = remote === undefined ? {} : { supportsRetuning: remote };
    expect(supportsRetuning('copilot', capabilities)).toBe(supported);
    expect(retuningUnavailableReason('copilot', capabilities) == null).toBe(supported);
  });

  it('does not enable unknown providers merely because a server advertises support', () => {
    const provider = 'unknown' as const;
      expect(supportsRetuning(provider, { supportsRetuning: true })).toBe(false);
      expect(supportsRetuning(provider, { supportsRetuning: false })).toBe(false);
      expect(supportsRetuning(provider)).toBe(false);
      expect(retuningUnavailableReason(provider, { supportsRetuning: true })).toContain('This app');
  });

  it('enables OpenCode variants only with explicit bridge support', () => {
    expect(supportsRetuning('opencode', { supportsRetuning: true })).toBe(true);
    expect(supportsRetuning('opencode', { supportsRetuning: false })).toBe(false);
    expect(supportsRetuning('opencode')).toBe(false);
  });

  it.each([true, false])('retains the reported %s capability instead of stripping it', (value) => {
    expect(agentCapabilitiesSchema.parse({ supportsRetuning: value }).supportsRetuning).toBe(value);
  });

  it('distinguishes old bridges from an explicit refusal', () => {
    const legacy = agentCapabilitiesSchema.parse({});
    expect(legacy).not.toHaveProperty('supportsRetuning');
    expect(supportsRetuning('copilot', legacy)).toBe(true);
    expect(retuningUnavailableReason('copilot', { supportsRetuning: false })).toContain('This device');
  });

  it.each([null, 'false', 0, {}])('does not treat malformed reported support %p as a legacy omission', (value) => {
    expect(agentCapabilitiesSchema.safeParse({ supportsRetuning: value }).success).toBe(false);
  });
});
