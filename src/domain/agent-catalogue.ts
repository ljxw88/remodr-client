import type { AgentProvider } from '@/domain/herdr';
import {
  contextTierSchema,
  modelCatalogueSchema,
  reasoningEffortSchema,
  type ModelSpec,
} from '@/domain/model-catalogue-schema';
import copilot from '@/domain/model-catalogues/copilot.json';

export const REASONING_EFFORTS = reasoningEffortSchema.options;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const CONTEXT_TIERS = contextTierSchema.options;
export type ContextTier = (typeof CONTEXT_TIERS)[number];
export type ContextOption = ModelSpec['contexts'][number];
export type { ModelSpec } from '@/domain/model-catalogue-schema';
export { supportsRetuning } from '@/domain/agent-capabilities';

const CATALOGUES = { copilot };
const UNAVAILABLE: Partial<Record<AgentProvider, string>> = {};
const CATALOGUE: Record<AgentProvider, ModelSpec[]> = {
  copilot: [],
  opencode: [],
  unknown: [],
};
for (const [provider, data] of Object.entries(CATALOGUES)) {
  const catalogue = modelCatalogueSchema.parse(data);
  if (catalogue.provider !== provider) {
    throw new Error(`Model catalogue provider mismatch: ${provider}`);
  }
  CATALOGUE[catalogue.provider] = catalogue.models;
  UNAVAILABLE[catalogue.provider] = catalogue.unavailableReason;
}

export function catalogueUnavailableReason(provider: AgentProvider): string | undefined {
  return UNAVAILABLE[provider];
}

export function modelsFor(provider: AgentProvider): ModelSpec[] {
  return CATALOGUE[provider] ?? [];
}

export function supportsTuning(provider: AgentProvider): boolean {
  return provider === 'opencode' || Object.hasOwn(CATALOGUES, provider);
}

export function findModel(
  provider: AgentProvider,
  modelId: string | null | undefined,
): ModelSpec | undefined {
  return modelId ? modelsFor(provider).find((model) => model.id === modelId) : undefined;
}

export function modelLabel(
  provider: AgentProvider,
  modelId: string | null | undefined,
): string {
  return findModel(provider, modelId)?.label ?? modelId ?? 'Auto';
}

export function effortsFor(
  provider: AgentProvider,
  modelId: string | null | undefined,
): ReasoningEffort[] {
  return findModel(provider, modelId)?.efforts ?? [];
}

export function contextsFor(
  provider: AgentProvider,
  modelId: string | null | undefined,
): ContextOption[] {
  return findModel(provider, modelId)?.contexts ?? [];
}

export type Tuning = {
  model: string | null;
  effort: ReasoningEffort | null;
  context: ContextTier | null;
};

/** Drop settings the new model cannot accept rather than carrying invalid flags. */
export function tuningForModel(
  provider: AgentProvider,
  model: string | null,
  previous: Tuning,
): Tuning {
  const efforts = effortsFor(provider, model);
  const tiers = contextsFor(provider, model).map((option) => option.tier);
  return {
    model,
    effort: previous.effort && efforts.includes(previous.effort) ? previous.effort : null,
    context: previous.context && tiers.includes(previous.context) ? previous.context : null,
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

export function contextLabel(option: ContextOption): string {
  return option.size;
}

/** Include off-catalogue settings already in force, so the UI does not hide them. */
export function contextChoices(
  provider: AgentProvider,
  modelId: string | null | undefined,
  current: ContextTier | null,
): ContextOption[] {
  const known = contextsFor(provider, modelId);
  if (!current || known.some((option) => option.tier === current)) return known;
  return [...known, { tier: current, size: TIER_NAMES[current] }];
}

const TIER_NAMES: Record<ContextTier, string> = {
  default: 'Standard',
  long_context: 'Long',
};

export function effortChoices(
  provider: AgentProvider,
  modelId: string | null | undefined,
  current: ReasoningEffort | null,
): ReasoningEffort[] {
  const known = effortsFor(provider, modelId);
  return !current || known.includes(current) ? known : [...known, current];
}
