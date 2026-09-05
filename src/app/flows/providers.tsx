import { router, useLocalSearchParams } from 'expo-router';
import { useRef } from 'react';
import { FlatList } from 'react-native';

import { FormError, FormPage, FormSection, MissingFlow, SelectionRow } from '@/components/ui/form-page';
import { launchableAgentProviderSchema, providerLabel, type LaunchableAgentProvider } from '@/domain/herdr';
import { agentDraftForProvider } from '@/features/agents/creation-flow';
import { useHerdr } from '@/features/agents/use-herdr';
import { flowDrafts, useFlowDraft } from '@/features/forms/flow-drafts';
import { herdrRepository } from '@/services/herdr-repository';

export default function ProvidersPage() {
  const params = useLocalSearchParams<{ flowId?: string | string[] }>();
  const flowId = typeof params.flowId === 'string' ? params.flowId : undefined;
  const draft = useFlowDraft(flowId);
  const { devices } = useHerdr();
  const selected = useRef(false);
  if (!flowId || draft?.kind !== 'new-agent') return <MissingFlow title="Provider" />;
  const device = devices[draft.deviceId];

  function choose(provider: LaunchableAgentProvider) {
    if (selected.current || !flowId) return;
    const current = flowDrafts.get(flowId);
    if (current?.kind !== 'new-agent') return;
    const live = herdrRepository.getSnapshot().devices[current.deviceId];
    if (!live?.runtime.providers.some((item) => item.provider === provider && item.available)) return;
    selected.current = true;
    flowDrafts.update(flowId, (value) => value.kind === 'new-agent' ? agentDraftForProvider(value, provider) : value);
    router.back();
  }

  return (
    <FormPage title="Provider" scroll={false}>
      <FormError message={!device ? 'This device is no longer available. Go back and choose another device.' : null} />
      <FormSection fill description="Availability is reported by the selected device.">
        <FlatList data={launchableAgentProviderSchema.options} keyExtractor={(provider) => provider}
          keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}
          renderItem={({ item: provider }) => {
            const manifest = device?.runtime.providers.find((item) => item.provider === provider);
            return <SelectionRow label={providerLabel(provider)} selected={provider === draft.provider}
              disabled={!manifest?.available} description={manifest?.available ? undefined : manifest?.unavailableReason || 'Not available on this device'}
              onPress={() => choose(provider)} />;
          }} />
      </FormSection>
    </FormPage>
  );
}
