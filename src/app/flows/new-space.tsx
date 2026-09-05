import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ThemedText } from '@/components/themed-text';
import { AppButton } from '@/components/ui/app-button';
import { FormError, FormPage, FormSection, MissingFlow, SelectionRow } from '@/components/ui/form-page';
import { TextField } from '@/components/ui/text-field';
import { createSpaceInputSchema } from '@/domain/herdr';
import { beginNewAgentFlow } from '@/features/agents/creation-flow';
import { useHerdr } from '@/features/agents/use-herdr';
import { selectWorkspace } from '@/features/agents/workspace-selection';
import { useHostSession } from '@/features/connection/use-host-session';
import { flowDrafts, useFlowDraft, type NewSpaceDraft } from '@/features/forms/flow-drafts';
import { useHosts } from '@/features/hosts/use-hosts';
import { herdrRepository } from '@/services/herdr-repository';
import { remoteClient } from '@/services/native-remote-client';
import { toUserMessage } from '@/utils/user-error';

export default function NewSpacePage() {
  const params = useLocalSearchParams<{ flowId?: string | string[] }>();
  const flowId = typeof params.flowId === 'string' ? params.flowId : undefined;
  const draft = useFlowDraft(flowId);
  if (!flowId || draft?.kind !== 'new-space') return <MissingFlow title="New Space" />;
  return <NewSpaceForm flowId={flowId} draft={draft} />;
}

function NewSpaceForm({ flowId, draft }: { flowId: string; draft: NewSpaceDraft }) {
  const { devices } = useHerdr();
  const { hosts } = useHosts();
  const session = useHostSession(draft.deviceId);
  const device = devices[draft.deviceId];
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const navigating = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useFocusEffect(useCallback(() => { navigating.current = false; }, []));
  const validation = !device ? 'This device is no longer available. Choose another device.'
    : device.connection !== 'connected' || session?.status !== 'connected'
      ? 'This device is not connected. Your draft is kept while it reconnects.'
      : !draft.cwd.trim() ? 'Root folder is required.' : null;

  function update(change: (current: NewSpaceDraft) => NewSpaceDraft) {
    if (submitting.current) return;
    setError(null);
    flowDrafts.update(flowId, (current) => current.kind === 'new-space' ? change(current) : current);
  }

  function choose(pathname: '/flows/devices' | '/flows/folders') {
    if (submitting.current || navigating.current) return;
    navigating.current = true;
    router.push({ pathname, params: { flowId } });
  }

  async function create() {
    if (submitting.current) return;
    const current = flowDrafts.get(flowId);
    if (current?.kind !== 'new-space') return;
    submitting.current = true;
    setCreating(true);
    setError(null);
    try {
      const live = herdrRepository.getSnapshot().devices[current.deviceId];
      if (!live) throw new Error('This device is no longer available. Choose another device.');
      if (live.connection !== 'connected' || remoteClient.getSession(current.deviceId)?.status !== 'connected') {
        throw new Error('This device is not connected. Reconnect before creating the space.');
      }
      const input = createSpaceInputSchema.parse({ cwd: current.cwd, label: current.label });
      const result = await herdrRepository.createSpace(input, current.deviceId);
      herdrRepository.selectDevice(current.deviceId);
      selectWorkspace(current.deviceId, result.workspaceId);
      const shouldNavigate = mounted.current;
      const fresh = herdrRepository.getSnapshot().devices[current.deviceId];
      let nextFlowId: string | undefined;
      if (shouldNavigate && fresh?.runtime.workspaces.some((space) =>
        space.id === result.workspaceId && (!space.deviceId || space.deviceId === current.deviceId),
      )) {
        nextFlowId = beginNewAgentFlow(fresh, result.workspaceId);
      }
      if (shouldNavigate) {
        if (nextFlowId) router.replace({ pathname: '/flows/new-agent', params: { flowId: nextFlowId } });
        else router.dismissTo('/');
      }
    } catch (cause) {
      submitting.current = false;
      if (mounted.current) {
        setError(toUserMessage(cause));
        setCreating(false);
      }
    }
  }

  return (
    <FormPage title="New Space" busy={creating} footer={
      <>
        <FormError message={error ?? validation} />
        <ThemedText type="caption" themeColor="textMuted">Next, choose an agent for this space.</ThemedText>
        <AppButton label={creating ? 'Creating space…' : 'Create space and continue'} disabled={creating || !!validation} onPress={() => void create()} />
      </>
    }>
      <FormSection>
        <SelectionRow label="Device" value={hosts.find((host) => host.id === draft.deviceId)?.name ?? draft.deviceId}
          disabled={creating} onPress={() => choose('/flows/devices')} />
      </FormSection>
      <TextField label="Space name (optional)" value={draft.label} onChangeText={(label) => update((current) => ({ ...current, label }))}
        placeholder="Uses the folder name" autoCapitalize="sentences" editable={!creating} returnKeyType="next" />
      <TextField label="Root folder" value={draft.cwd} onChangeText={(cwd) => update((current) => ({ ...current, cwd }))}
        placeholder="~/Projects/my-app" autoCapitalize="none" autoCorrect={false} editable={!creating} returnKeyType="done" />
      <FormSection>
        <SelectionRow label="Browse folders" description="Choose a folder on this device." disabled={creating} onPress={() => choose('/flows/folders')} />
      </FormSection>
    </FormPage>
  );
}
