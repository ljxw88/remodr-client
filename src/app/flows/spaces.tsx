import { router, useLocalSearchParams } from 'expo-router';
import { useRef } from 'react';
import { FlatList } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { FormError, FormPage, FormSection, MissingFlow, SelectionRow } from '@/components/ui/form-page';
import { useHerdr } from '@/features/agents/use-herdr';
import { flowDrafts, useFlowDraft } from '@/features/forms/flow-drafts';
import { herdrRepository } from '@/services/herdr-repository';

export default function SpacesPage() {
  const params = useLocalSearchParams<{ flowId?: string | string[] }>();
  const flowId = typeof params.flowId === 'string' ? params.flowId : undefined;
  const draft = useFlowDraft(flowId);
  const { devices } = useHerdr();
  const selected = useRef(false);
  if (!flowId || draft?.kind !== 'new-agent') return <MissingFlow title="Space" />;
  const device = devices[draft.deviceId];
  const spaces = device?.runtime.workspaces.filter((space) => !space.deviceId || space.deviceId === draft.deviceId) ?? [];

  function choose(workspaceId: string) {
    if (selected.current || !flowId) return;
    const current = flowDrafts.get(flowId);
    if (current?.kind !== 'new-agent') return;
    const live = herdrRepository.getSnapshot().devices[current.deviceId];
    if (!live?.runtime.workspaces.some((space) =>
      space.id === workspaceId && (!space.deviceId || space.deviceId === current.deviceId),
    )) return;
    selected.current = true;
    flowDrafts.update(flowId, (value) => value.kind === 'new-agent' ? { ...value, workspaceId } : value);
    router.back();
  }

  return (
    <FormPage title="Space" scroll={false}>
      <FormError message={!device ? 'This device is no longer available. Go back and choose another device.' : null} />
      <FormSection fill>
        <FlatList data={spaces} keyExtractor={(space) => space.id} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}
          renderItem={({ item }) => <SelectionRow label={item.name} description={item.cwd ?? undefined}
            selected={draft.workspaceId === item.id} onPress={() => choose(item.id)} />}
          ListEmptyComponent={<ThemedText type="small" themeColor="textSecondary">No spaces on this device. Go back and choose another device, or create a space from Agents.</ThemedText>} />
      </FormSection>
    </FormPage>
  );
}
