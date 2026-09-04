import { ChipPicker } from '@/components/ui/chip-picker';
import {
  CONTEXT_LABELS,
  contextsFor,
  EFFORT_LABELS,
  effortsFor,
  modelsFor,
  tuningForModel,
  type ContextTier,
  type ReasoningEffort,
  type Tuning,
} from '@/domain/agent-catalogue';
import type { AgentProvider } from '@/domain/herdr';

/** Stands for "send no flag", which is not the same as any real value. */
const AUTO = 'auto';

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
  const efforts = effortsFor(provider, value.model);
  const contexts = contextsFor(provider, value.model);

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
        onSelect={(id) =>
          onChange(tuningForModel(provider, id === AUTO ? null : id, value))
        }
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
