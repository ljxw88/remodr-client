import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { AppButton } from '@/components/ui/app-button';
import { FormError, FormPage, FormSection, SelectionRow } from '@/components/ui/form-page';
import { Colors } from '@/constants/theme';
import type { AgentVariantOptions } from '@/domain/herdr';
import { flowDrafts, type AgentSettingsDraft } from '@/features/forms/flow-drafts';
import { herdrRepository } from '@/services/herdr-repository';
import { toUserMessage } from '@/utils/user-error';
import { agentEditError } from './agent-edit-flow';
import { useHerdr } from './use-herdr';

export function OpenCodeVariantSettings({ flowId, draft }: { flowId: string; draft: AgentSettingsDraft }) {
  const { devices } = useHerdr();
  const [options, setOptions] = useState<AgentVariantOptions | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const { agentId } = draft;
  const liveAgent = devices[draft.deviceId]?.runtime.agents.find((item) => item.id === agentId);
  // Bind a pending form once discovery finishes; never rebind a form that
  // already belongs to an identified session.
  const providerSessionId = draft.providerSessionId
    ?? (liveAgent?.provider === 'opencode' ? liveAgent.providerSessionId : null);
  const availabilityError = agentEditError(devices, draft);
  const selection = draft.variantSelection;
  const modelChanged = selection && options && selection.modelToken !== options.modelToken;
  const changed = selection != null && selection.initial !== selection.selected;

  useEffect(() => {
    let cancelled = false;
    if (!providerSessionId || availabilityError) return;
    void herdrRepository.agentVariantOptions(agentId, providerSessionId).then((result) => {
      if (cancelled) return;
      setOptions(result);
      const current = flowDrafts.get(flowId);
      if (current?.kind === 'agent-settings' && (!current.variantSelection || !current.providerSessionId)) {
        flowDrafts.update(flowId, (value) => value.kind === 'agent-settings'
          ? {
            ...value, providerSessionId: value.providerSessionId ?? providerSessionId,
            variantSelection: value.variantSelection ?? {
              modelToken: result.modelToken, initial: result.currentVariant, selected: result.currentVariant,
            },
          } : value);
      }
    }).catch((cause) => {
      if (!cancelled) setError(toUserMessage(cause));
    });
    return () => { cancelled = true; };
  }, [agentId, availabilityError, flowId, providerSessionId, revision]);

  function reload() {
    if (submitting.current) return;
    flowDrafts.update(flowId, (value) => value.kind === 'agent-settings'
      ? { ...value, variantSelection: undefined } : value);
    setError(null);
    setOptions(null);
    setRevision((value) => value + 1);
  }

  function choose(selected: string | null) {
    if (submitting.current) return;
    flowDrafts.update(flowId, (value) => value.kind === 'agent-settings' && value.variantSelection
      ? { ...value, variantSelection: { ...value.variantSelection, selected } } : value);
  }

  async function apply() {
    if (submitting.current) return;
    const current = flowDrafts.get(flowId);
    if (current?.kind !== 'agent-settings' || !current.variantSelection || !current.providerSessionId) {
      setError('Reopen model settings for the current OpenCode session.');
      return;
    }
    const unavailable = agentEditError(herdrRepository.getSnapshot().devices, current);
    if (unavailable) { setError(unavailable); return; }
    if (current.variantSelection.initial === current.variantSelection.selected) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      await herdrRepository.retuneAgent({
        agentId: current.agentId, providerSessionId: current.providerSessionId,
        variant: current.variantSelection.selected, modelToken: current.variantSelection.modelToken,
      });
      if (mounted.current) router.back();
    } catch (cause) {
      submitting.current = false;
      if (mounted.current) {
        setError(toUserMessage(cause));
        setBusy(false);
      }
    }
  }

  const message = availabilityError
    ?? (!providerSessionId ? 'Waiting for OpenCode to report its selected session.' : null)
    ?? (modelChanged ? 'The OpenCode model changed. Reload variants before applying.' : null)
    ?? error;

  return (
    <FormPage title="Model Settings" busy={busy} footer={
      <>
        <FormError message={message} />
        <AppButton
          label={busy ? 'Applying variant…' : 'Apply variant'}
          disabled={busy || !options || !changed || !!message}
          onPress={() => void apply()}
        />
      </>
    }>
      {options ? (
        <>
          <FormSection title="Current OpenCode model">
            <SelectionRow label={options.modelLabel} />
          </FormSection>
          <FormSection title="Reasoning effort" description="These are the variants available in this agent's /variants menu. Default clears the variant override.">
            <SelectionRow label="Default" selected={selection?.selected === null} disabled={busy || !!modelChanged} onPress={() => choose(null)} />
            {options.variants.map((variant) => (
              <SelectionRow key={variant} label={variant} selected={selection?.selected === variant}
                disabled={busy || !!modelChanged} onPress={() => choose(variant)} />
            ))}
          </FormSection>
          {options.variants.length === 0 ? (
            <ThemedText type="small" themeColor="textSecondary">This model has no additional reasoning variants.</ThemedText>
          ) : null}
        </>
      ) : !message ? <ActivityIndicator color={Colors.accent} accessibilityLabel="Loading OpenCode variants" /> : null}
      <ThemedText type="small" themeColor="textSecondary">
        Changes apply to this OpenCode TUI without restarting or sending a message.
        Leave its terminal prompt empty while choosing a variant. Change models in OpenCode itself.
      </ThemedText>
      <AppButton label="Reload variants" variant="secondary" disabled={busy || !providerSessionId || (!options && !error)} onPress={reload}
        accessibilityHint="Discard the unapplied choice and read the active OpenCode variants again" />
    </FormPage>
  );
}
