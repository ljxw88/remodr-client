import type { AgentProvider, RemoteAgent } from './herdr';

type RetuningCapabilities = Pick<RemoteAgent['capabilities'], 'supportsRetuning'>;

export function retuningUnavailableReason(
  provider: AgentProvider,
  capabilities?: RetuningCapabilities,
): string | null {
  if (provider === 'opencode') {
    return capabilities?.supportsRetuning === true
      ? null
      : 'This device needs an updated bridge to change OpenCode reasoning variants.';
  }
  if (provider !== 'copilot') {
    return 'This app does not support live model settings for this provider.';
  }
  if (capabilities?.supportsRetuning === false) {
    return 'This device does not support live model settings for this agent. Your changes are kept here.';
  }
  // Older bridges omit this field. Preserve their existing Copilot-only behavior.
  return null;
}

export function supportsRetuning(provider: AgentProvider, capabilities?: RetuningCapabilities): boolean {
  return retuningUnavailableReason(provider, capabilities) == null;
}
