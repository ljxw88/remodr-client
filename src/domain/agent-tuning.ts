import type { AgentProvider } from '@/domain/herdr';

/**
 * What an agent can be tuned with before it starts.
 *
 * Only GitHub Copilot for now. The other CLIs take a model differently, or not
 * from the command line at all, and offering a control that silently does
 * nothing is worse than not offering one.
 */
export function supportsTuning(provider: AgentProvider): boolean {
  return provider === 'copilot';
}

export const REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export type AgentModel = {
  id: string;
  label: string;
};

/**
 * Models offered for Copilot, newest family first.
 *
 * The CLI has no way to list what an account can actually reach — an
 * unavailable one is only refused at startup — so this is a shipped list
 * rather than a discovered one, and the default is to send no model at all and
 * let the CLI choose. That is the one option guaranteed to work everywhere.
 */
export const COPILOT_MODELS: AgentModel[] = [
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
  { id: 'claude-opus-4.8', label: 'Claude Opus 4.8' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5' },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { id: 'grok-4.6', label: 'Grok 4.6' },
];

export function modelsFor(provider: AgentProvider): AgentModel[] {
  return provider === 'copilot' ? COPILOT_MODELS : [];
}

/** How a chosen effort reads in the list, so the scale is not just jargon. */
export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};
