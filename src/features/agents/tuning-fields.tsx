import { useState } from 'react';

import { FormSection, SelectionRow } from '@/components/ui/form-page';
import {
  contextChoices,
  contextLabel,
  EFFORT_LABELS,
  effortChoices,
  modelLabel,
  type Tuning,
} from '@/domain/agent-catalogue';
import type { AgentProvider } from '@/domain/herdr';

type Props = {
  provider: AgentProvider;
  value: Tuning;
  onChange: (value: Tuning) => void;
  onChooseModel: () => void;
  showModel?: boolean;
};

export function TuningFields({ provider, value, onChange, onChooseModel, showModel = true }: Props) {
  const [expanded, setExpanded] = useState<'effort' | 'context' | null>(null);
  const efforts = effortChoices(provider, value.model, value.effort);
  const contexts = contextChoices(provider, value.model, value.context);
  const selectedContext = contexts.find((option) => option.tier === value.context);

  if (!showModel && efforts.length === 0 && contexts.length === 0) return null;

  return (
    <FormSection>
      {showModel ? (
        <SelectionRow label="Model" value={modelLabel(provider, value.model)} onPress={onChooseModel} />
      ) : null}
      {efforts.length > 0 ? (
        <>
          <SelectionRow
            label="Reasoning effort"
            value={value.effort ? EFFORT_LABELS[value.effort] ?? value.effort : 'Default'}
            onPress={() => setExpanded(expanded === 'effort' ? null : 'effort')}
          />
          {expanded === 'effort' ? (
            <>
              <SelectionRow
                label="Default"
                selected={value.effort == null}
                onPress={() => { onChange({ ...value, effort: null }); setExpanded(null); }}
              />
              {efforts.map((effort) => (
                <SelectionRow
                  key={effort}
                  label={EFFORT_LABELS[effort] ?? effort}
                  selected={value.effort === effort}
                  onPress={() => { onChange({ ...value, effort }); setExpanded(null); }}
                />
              ))}
            </>
          ) : null}
        </>
      ) : null}
      {contexts.length > 0 ? (
        <>
          <SelectionRow
            label="Context window"
            value={selectedContext ? contextLabel(selectedContext) || value.context || 'Default' : 'Default'}
            onPress={() => setExpanded(expanded === 'context' ? null : 'context')}
          />
          {expanded === 'context' ? (
            <>
              <SelectionRow
                label="Default"
                selected={value.context == null}
                onPress={() => { onChange({ ...value, context: null }); setExpanded(null); }}
              />
              {contexts.map((context) => (
                <SelectionRow
                  key={context.tier}
                  label={contextLabel(context) || context.tier}
                  selected={value.context === context.tier}
                  onPress={() => { onChange({ ...value, context: context.tier }); setExpanded(null); }}
                />
              ))}
            </>
          ) : null}
        </>
      ) : null}
    </FormSection>
  );
}
