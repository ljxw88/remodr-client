import type { AgentProvider } from '@/domain/herdr';

/**
 * What an agent can be tuned with.
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

/**
 * Copilot names context sizes rather than taking a number, and which sizes a
 * model has differs between them.
 */
export const CONTEXT_TIERS = ['default', 'long_context'] as const;
export type ContextTier = (typeof CONTEXT_TIERS)[number];

export type AgentModel = {
  id: string;
  label: string;
  /** Empty where the model has no reasoning setting at all. */
  efforts: ReasoningEffort[];
  /** Always includes `default`; only some models offer the longer window. */
  contexts: ContextTier[];
};

const BOTH_CONTEXTS: ContextTier[] = ['default', 'long_context'];
const ONE_CONTEXT: ContextTier[] = ['default'];

/**
 * Models offered for Copilot, with what each one can actually be asked for.
 *
 * The ranges are not the same shape: some stop at `high`, some go to `max`,
 * one starts at `minimal`, and a few have no reasoning setting at all. Only
 * some have the longer context window. A single shared list would mean
 * offering settings the CLI refuses at startup.
 *
 * The CLI cannot be asked what an account can reach — an unavailable model is
 * only refused when the agent starts — so this is a shipped list, and the
 * default is to send no flag and let the CLI choose.
 */
export const COPILOT_MODELS: AgentModel[] = [
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    contexts: BOTH_CONTEXTS,
  },
  {
    id: 'claude-opus-4.8',
    label: 'Claude Opus 4.8',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    contexts: BOTH_CONTEXTS,
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    contexts: BOTH_CONTEXTS,
  },
  {
    id: 'claude-haiku-4.5',
    label: 'Claude Haiku 4.5',
    efforts: [],
    contexts: ONE_CONTEXT,
  },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    contexts: BOTH_CONTEXTS,
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    contexts: BOTH_CONTEXTS,
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    contexts: BOTH_CONTEXTS,
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    contexts: BOTH_CONTEXTS,
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    contexts: BOTH_CONTEXTS,
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 mini',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    contexts: ONE_CONTEXT,
  },
  {
    id: 'gpt-5.3-codex',
    label: 'GPT-5.3-Codex',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    contexts: ONE_CONTEXT,
  },
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    efforts: ['low', 'medium', 'high'],
    contexts: BOTH_CONTEXTS,
  },
  {
    id: 'gemini-3.7-flash',
    label: 'Gemini 3.7 Flash',
    efforts: ['low', 'medium', 'high'],
    contexts: BOTH_CONTEXTS,
  },
  {
    id: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    efforts: ['minimal', 'low', 'medium', 'high'],
    contexts: BOTH_CONTEXTS,
  },
  {
    id: 'grok-4.6',
    label: 'Grok 4.6',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    contexts: BOTH_CONTEXTS,
  },
  {
    id: 'grok-4.5',
    label: 'Grok 4.5',
    efforts: ['low', 'medium', 'high'],
    contexts: BOTH_CONTEXTS,
  },
  {
    id: 'mai-code-1.1-flash',
    label: 'MAI-Code-1.1-Flash',
    efforts: ['low', 'medium', 'high'],
    contexts: ONE_CONTEXT,
  },
];

export function modelsFor(provider: AgentProvider): AgentModel[] {
  return provider === 'copilot' ? COPILOT_MODELS : [];
}

export function findModel(modelId: string | null | undefined): AgentModel | undefined {
  return modelId ? COPILOT_MODELS.find((model) => model.id === modelId) : undefined;
}

/** What to show for a model, falling back to whatever the agent reported. */
export function modelLabel(modelId: string | null | undefined): string {
  return findModel(modelId)?.label ?? modelId ?? 'Auto';
}

/**
 * The efforts worth offering for a model.
 *
 * Empty when no model is pinned: which efforts exist depends on the model, so
 * until one is chosen there is no honest list to show.
 */
export function effortsFor(modelId: string | null | undefined): ReasoningEffort[] {
  return findModel(modelId)?.efforts ?? [];
}

export function contextsFor(modelId: string | null | undefined): ContextTier[] {
  const contexts = findModel(modelId)?.contexts ?? [];
  // A single choice is not a choice, so there is nothing to offer.
  return contexts.length > 1 ? contexts : [];
}

/** Keeps a setting only where the newly chosen model still offers it. */
export function keepEffort(
  modelId: string | null | undefined,
  effort: ReasoningEffort | null,
): ReasoningEffort | null {
  return effort && effortsFor(modelId).includes(effort) ? effort : null;
}

export function keepContext(
  modelId: string | null | undefined,
  context: ContextTier | null,
): ContextTier | null {
  return context && contextsFor(modelId).includes(context) ? context : null;
}

export const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export const CONTEXT_LABELS: Record<ContextTier, string> = {
  default: 'Standard',
  long_context: 'Long',
};
