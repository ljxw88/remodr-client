import type { AgentProvider } from '@/domain/herdr';

/**
 * What every supported CLI can be asked to run, and with what.
 *
 * One table, one entry per CLI, one entry per model. Nothing else in the app
 * should know which CLI takes a model or which reasoning levels a model has —
 * it asks here. Adding a model, or a whole CLI, is an edit to this file.
 *
 * It is fixed rather than fetched. No CLI will say what an account can
 * actually reach — an unavailable model is only refused when the agent starts
 * — so the list ships with the app and moves when the app does. Every choice
 * is optional for that reason: sending no flag leaves the CLI to pick, which
 * is the one thing that works on every account.
 */

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

/** CLIs name context sizes rather than taking a number of tokens. */
export const CONTEXT_TIERS = ['default', 'long_context'] as const;
export type ContextTier = (typeof CONTEXT_TIERS)[number];

export type ModelSpec = {
  id: string;
  label: string;
  /** Empty where the model has no reasoning setting at all. */
  efforts: ReasoningEffort[];
  /** Always includes `default`; only some models offer the longer window. */
  contexts: ContextTier[];
};

const BOTH: ContextTier[] = ['default', 'long_context'];
const STANDARD_ONLY: ContextTier[] = ['default'];

const COPILOT_MODELS: ModelSpec[] = [
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    contexts: BOTH,
  },
  {
    id: 'claude-opus-4.8',
    label: 'Claude Opus 4.8',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    contexts: BOTH,
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    contexts: BOTH,
  },
  {
    id: 'claude-haiku-4.5',
    label: 'Claude Haiku 4.5',
    efforts: [],
    contexts: STANDARD_ONLY,
  },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    contexts: BOTH,
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    contexts: BOTH,
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    contexts: BOTH,
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    contexts: BOTH,
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    contexts: BOTH,
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 mini',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    contexts: STANDARD_ONLY,
  },
  {
    id: 'gpt-5.3-codex',
    label: 'GPT-5.3-Codex',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    contexts: STANDARD_ONLY,
  },
  {
    id: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    efforts: ['low', 'medium', 'high'],
    contexts: BOTH,
  },
  {
    id: 'gemini-3.7-flash',
    label: 'Gemini 3.7 Flash',
    efforts: ['low', 'medium', 'high'],
    contexts: BOTH,
  },
  {
    id: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    efforts: ['minimal', 'low', 'medium', 'high'],
    contexts: BOTH,
  },
  {
    id: 'grok-4.6',
    label: 'Grok 4.6',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    contexts: BOTH,
  },
  {
    id: 'grok-4.5',
    label: 'Grok 4.5',
    efforts: ['low', 'medium', 'high'],
    contexts: BOTH,
  },
  {
    id: 'mai-code-1.1-flash',
    label: 'MAI-Code-1.1-Flash',
    efforts: ['low', 'medium', 'high'],
    contexts: STANDARD_ONLY,
  },
];

/**
 * A CLI with no models listed cannot be tuned from the app.
 *
 * That is a statement about this app, not about the CLI: the others take a
 * model differently, or not from the command line at all, and the bridge has
 * no flags to send for them. Giving one an entry here means teaching the
 * bridge its flags at the same time.
 */
const CATALOGUE: Record<AgentProvider, ModelSpec[]> = {
  copilot: COPILOT_MODELS,
  claude: [],
  codex: [],
  opencode: [],
  unknown: [],
};

export function modelsFor(provider: AgentProvider): ModelSpec[] {
  return CATALOGUE[provider] ?? [];
}

export function supportsTuning(provider: AgentProvider): boolean {
  return modelsFor(provider).length > 0;
}

export function findModel(
  provider: AgentProvider,
  modelId: string | null | undefined,
): ModelSpec | undefined {
  return modelId
    ? modelsFor(provider).find((model) => model.id === modelId)
    : undefined;
}

/** What to show for a model, falling back to whatever the agent reported. */
export function modelLabel(
  provider: AgentProvider,
  modelId: string | null | undefined,
): string {
  return findModel(provider, modelId)?.label ?? modelId ?? 'Auto';
}

/**
 * The efforts worth offering for a model.
 *
 * Empty when no model is pinned: which efforts exist depends on the model, so
 * until one is chosen there is no honest list to show.
 */
export function effortsFor(
  provider: AgentProvider,
  modelId: string | null | undefined,
): ReasoningEffort[] {
  return findModel(provider, modelId)?.efforts ?? [];
}

export function contextsFor(
  provider: AgentProvider,
  modelId: string | null | undefined,
): ContextTier[] {
  const contexts = findModel(provider, modelId)?.contexts ?? [];
  // A single choice is not a choice, so there is nothing to offer.
  return contexts.length > 1 ? contexts : [];
}

export type Tuning = {
  model: string | null;
  effort: ReasoningEffort | null;
  context: ContextTier | null;
};

/**
 * The settings that survive a change of model.
 *
 * Anything the new model does not reach is dropped rather than carried into a
 * startup the CLI refuses.
 */
export function tuningForModel(
  provider: AgentProvider,
  model: string | null,
  previous: Tuning,
): Tuning {
  const efforts: readonly ReasoningEffort[] = effortsFor(provider, model);
  const contexts: readonly ContextTier[] = contextsFor(provider, model);
  return {
    model,
    effort:
      previous.effort && efforts.includes(previous.effort) ? previous.effort : null,
    context:
      previous.context && contexts.includes(previous.context)
        ? previous.context
        : null,
  };
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
