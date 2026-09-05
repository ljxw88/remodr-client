import { router, useLocalSearchParams } from 'expo-router';
import { useRef } from 'react';
import { ActivityIndicator, FlatList } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { AppButton } from '@/components/ui/app-button';
import { FormError, FormPage, MissingFlow, SelectionRow } from '@/components/ui/form-page';
import { agentDraftForDevice, spaceDraftForDevice } from '@/features/agents/creation-flow';
import { useHerdr } from '@/features/agents/use-herdr';
import { flowDrafts, useFlowDraft } from '@/features/forms/flow-drafts';
import { useHosts } from '@/features/hosts/use-hosts';
import { herdrRepository } from '@/services/herdr-repository';

export default function DevicesPage() {
  const params = useLocalSearchParams<{ flowId?: string | string[] }>();
  const flowId = typeof params.flowId === 'string' ? params.flowId : undefined;
  const draft = useFlowDraft(flowId);
  const { devices } = useHerdr();
  const { hosts, loading, error, reload } = useHosts();
  const selected = useRef(false);
  if (!flowId || (draft?.kind !== 'new-agent' && draft?.kind !== 'new-space')) return <MissingFlow title="Device" />;

  function choose(deviceId: string) {
    if (selected.current || !flowId) return;
    const live = herdrRepository.getSnapshot().devices[deviceId];
    const current = flowDrafts.get(flowId);
    if (!live || (current?.kind !== 'new-agent' && current?.kind !== 'new-space')) return;
    selected.current = true;
    flowDrafts.update(flowId, (value) => value.kind === 'new-agent' ? agentDraftForDevice(value, live)
      : value.kind === 'new-space' ? spaceDraftForDevice(value, deviceId) : value);
    router.back();
  }

  return (
    <FormPage title="Device" scroll={false}>
      <FormError message={error} />
      {error ? <AppButton label="Try again" variant="secondary" onPress={() => void reload()} /> : null}
      {loading ? <ActivityIndicator /> : <FlatList data={hosts} keyExtractor={(host) => host.id} keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => {
          const device = devices[item.id];
          return <SelectionRow label={item.name} description={!device ? 'Connect from Devices before using this device.'
            : device.connection === 'connected' ? `${item.username}@${item.hostname}` : 'Offline — you can keep editing a local draft.'}
            selected={draft.deviceId === item.id} disabled={!device} onPress={() => choose(item.id)} />;
        }}
        ListEmptyComponent={<ThemedText type="small" themeColor="textSecondary">No saved devices. Add a device before continuing.</ThemedText>} />}
    </FormPage>
  );
}
