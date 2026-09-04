import { ChipPicker } from '@/components/ui/chip-picker';
import {
  CONTEXT_LABELS,
  contextsFor,
  EFFORT_LABELS,
  effortsFor,
  modelsFor,
  type ContextTier,
  type ReasoningEffort,
} from '@/domain/agent-tuning';
import type { AgentProvider } from '@/domain/herdr';

/** Stands for "send no flag", which is not the same as any real value. */
export const AUTO = 'auto';

export type Tuning = {
  model: string | null;
  effort: ReasoningEffort | null;
  context: ContextTier | null;
};

type Props = {
  provider: AgentProvider;
  value: Tuning;
  onChange: (value: Tuning) => void;
};

/**
 * Model, reasoning effort and context window.
 *
 * Effort and context are drawn from the chosen model rather than from one
 * shared list, because the ranges are not the same shape — some models stop at
 * high, some reach max, one starts at minimal, and a few have no reasoning
 * setting at all. Neither appears until a model is pinned: without one the CLI
 * chooses, and there is no telling which range would apply.
 */
export function AgentTuningPicker({ provider, value, onChange }: Props) {
  const efforts = effortsFor(value.model);
  const contexts = contextsFor(value.model);

  return (
    <>
      <ChipPicker
        label="MODEL"
        options={[
          { id: AUTO, label: 'Auto' },
          ...modelsFor(provider).map((model) => ({
            id: model.id,
            label: model.label,
          })),
        ]}
        selectedId={value.model ?? AUTO}
        onSelect={(id) => {
          const model = id === AUTO ? null : id;
          // Settings the new model cannot reach are dropped rather than
          // carried over into a startup failure.
          onChange({
            model,
            effort: effortsFor(model).includes(value.effort as ReasoningEffort)
              ? value.effort
              : null,
            context: contextsFor(model).includes(value.context as ContextTier)
              ? value.context
              : null,
          });
        }}
      />

      {efforts.length > 0 ? (
        <ChipPicker
          label="REASONING EFFORT"
          options={[
            { id: AUTO, label: 'Default' },
            ...efforts.map((effort) => ({
              id: effort,
              label: EFFORT_LABELS[effort],
            })),
          ]}
          selectedId={value.effort ?? AUTO}
          onSelect={(id) =>
            onChange({
              ...value,
              effort: id === AUTO ? null : (id as ReasoningEffort),
            })
          }
        />
      ) : null}

      {contexts.length > 0 ? (
        <ChipPicker
          label="CONTEXT WINDOW"
          options={[
            { id: AUTO, label: 'Default' },
            ...contexts.map((tier) => ({
              id: tier,
              label: CONTEXT_LABELS[tier],
            })),
          ]}
          selectedId={value.context ?? AUTO}
          onSelect={(id) =>
            onChange({
              ...value,
              context: id === AUTO ? null : (id as ContextTier),
            })
          }
        />
      ) : null}
    </>
  );
}
