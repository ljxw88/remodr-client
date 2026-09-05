import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { AppButton } from '@/components/ui/app-button';
import { FormError, FormPage, MissingFlow } from '@/components/ui/form-page';
import { supportsRetuning } from '@/domain/agent-catalogue';
import { agentEditError, tuningChanges } from '@/features/agents/agent-edit-flow';
import { TuningFields } from '@/features/agents/tuning-fields';
import { useHerdr } from '@/features/agents/use-herdr';
import { flowDrafts, useFlowDraft } from '@/features/forms/flow-drafts';
import { herdrRepository } from '@/services/herdr-repository';
import { toUserMessage } from '@/utils/user-error';

export default function AgentSettingsPage() {
  const params = useLocalSearchParams<{ flowId?: string | string[] }>();
  const flowId = typeof params.flowId === 'string' ? params.flowId : undefined;
  const draft = useFlowDraft(flowId);
  const { devices } = useHerdr();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const mounted = useRef(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  if (!flowId || !draft || draft.kind !== 'agent-settings' || !supportsRetuning(draft.provider)) {
    return <MissingFlow title="Model Settings Unavailable" />;
  }
  const availabilityError = agentEditError(devices, draft);
  const { changed, restarts } = tuningChanges(draft.initialTuning, draft.tuning);

  async function apply() {
    if (busyRef.current) return;
    const current = flowDrafts.get(flowId);
    if (!current || current.kind !== 'agent-settings') return;
    const unavailable = agentEditError(herdrRepository.getSnapshot().devices, current);
    if (unavailable) { setError(unavailable); return; }
    if (!tuningChanges(current.initialTuning, current.tuning).changed) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await herdrRepository.retuneAgent({ agentId: current.agentId, ...current.tuning });
      if (mounted.current) router.back();
    } catch (cause) {
      if (!mounted.current) return;
      busyRef.current = false;
      setBusy(false);
      setError(toUserMessage(cause));
    }
  }

  return (
    <FormPage
      title="Model Settings"
      busy={busy}
      footer={
        <>
          <FormError message={error ?? availabilityError} />
          <AppButton
            label={busy ? 'Applying…' : restarts ? 'Apply and restart' : 'Apply'}
            disabled={busy || !changed || !!availabilityError}
            onPress={() => void apply()}
          />
        </>
      }>
      <View pointerEvents={busy ? 'none' : 'auto'}>
        <TuningFields
          provider={draft.provider}
          value={draft.tuning}
          onChooseModel={() => {
            if (!busyRef.current) router.push({ pathname: '/flows/models', params: { flowId } });
          }}
          onChange={(tuning) => {
            if (busyRef.current) return;
            setError(null);
            flowDrafts.update(flowId, (current) =>
              current.kind === 'agent-settings' ? { ...current, tuning } : current,
            );
          }}
        />
      </View>
      <ThemedText type="small" themeColor="textSecondary">
        Changes stay here until you apply them.
      </ThemedText>
      {restarts ? (
        <ThemedText type="small" themeColor="textSecondary">
          Reasoning and context are only read when the agent starts. Applying these changes restarts
          the agent and interrupts its current work. The conversation is kept.
        </ThemedText>
      ) : null}
    </FormPage>
  );
}
