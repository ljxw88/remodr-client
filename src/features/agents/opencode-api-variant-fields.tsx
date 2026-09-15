import { useEffect, useState } from 'react';
import { ActivityIndicator } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { AppButton } from '@/components/ui/app-button';
import { FormError, FormSection, SelectionRow } from '@/components/ui/form-page';
import { Colors } from '@/constants/theme';
import type { AgentVariantOptions } from '@/domain/herdr';
import { flowDrafts, type AgentSettingsDraft } from '@/features/forms/flow-drafts';
import { herdrRepository } from '@/services/herdr-repository';
import { toUserMessage } from '@/utils/user-error';

export function OpenCodeApiVariantFields({ flowId, draft, busy, unavailable }: {
  flowId: string;
  draft: AgentSettingsDraft;
  busy: boolean;
  unavailable: string | null;
}) {
  const [options, setOptions] = useState<AgentVariantOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const { agentId, providerSessionId } = draft;
  const model = draft.tuning.model;

  useEffect(() => {
    let cancelled = false;
    if (!model || !providerSessionId || unavailable) return;
    void herdrRepository.agentVariantOptions(agentId, providerSessionId, model).then((result) => {
      if (cancelled) return;
      if (result.modelToken !== model) throw new Error('The OpenCode model changed. Reload variants.');
      setOptions(result);
      setError(null);
      flowDrafts.update(flowId, (value) => {
        if (value.kind !== 'agent-settings' || value.tuning.model !== model) return value;
        const previous = value.variantSelection;
        return { ...value, variantSelection: previous?.modelToken === model ? previous : {
          modelToken: result.modelToken, initial: result.currentVariant, selected: result.currentVariant,
        } };
      });
    }).catch((cause) => { if (!cancelled) setError(toUserMessage(cause)); });
    return () => { cancelled = true; };
  }, [agentId, flowId, model, providerSessionId, revision, unavailable]);

  const selection = draft.variantSelection;
  const ready = options?.modelToken === model && selection?.modelToken === model && !error && !unavailable;
  function choose(selected: string | null) {
    if (busy || !ready) return;
    flowDrafts.update(flowId, (value) => value.kind === 'agent-settings' && value.variantSelection
      ? { ...value, variantSelection: { ...value.variantSelection, selected } } : value);
  }

  return (
    <FormSection title="Reasoning variant" description="Choices come from this model's OpenCode configuration. Default uses no app variant override.">
      {!model ? <ThemedText type="small" themeColor="textSecondary">
        Choose a specific model to select a reasoning variant.
      </ThemedText> : <>
        <FormError message={error} />
        {options?.modelToken === model ? <>
          <SelectionRow label="Default" selected={selection?.selected === null}
            disabled={busy || !ready} onPress={() => choose(null)} />
          {options.variants.map((variant) => <SelectionRow key={variant} label={variant}
            selected={selection?.selected === variant} disabled={busy || !ready} onPress={() => choose(variant)} />)}
          {options.variants.length === 0 ? <ThemedText type="small" themeColor="textSecondary">
            This model has no additional reasoning variants.
          </ThemedText> : null}
        </> : !error && !unavailable ? <ActivityIndicator color={Colors.accent} accessibilityLabel="Loading OpenCode variants" /> : null}
        <AppButton label="Reload variants" variant="secondary" disabled={busy || !!unavailable || (!options && !error)}
          onPress={() => {
            flowDrafts.update(flowId, (value) => value.kind === 'agent-settings'
              ? { ...value, variantSelection: undefined } : value);
            setOptions(null);
            setError(null);
            setRevision((value) => value + 1);
          }} />
      </>}
    </FormSection>
  );
}
