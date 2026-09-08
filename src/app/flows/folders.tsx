import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef } from 'react';

import { MissingFlow } from '@/components/ui/form-page';
import { useHerdr } from '@/features/agents/use-herdr';
import { refreshSessions, useHostSession } from '@/features/connection/use-host-session';
import { RemoteFileExplorer } from '@/features/files/remote-file-explorer';
import { useRemoteDirectory } from '@/features/files/use-remote-directory';
import { flowDrafts, useFlowDraft, type NewSpaceDraft } from '@/features/forms/flow-drafts';
import { useHosts } from '@/features/hosts/use-hosts';
import { herdrRepository } from '@/services/herdr-repository';
import { remoteClient } from '@/services/native-remote-client';

export default function FoldersPage() {
  const params = useLocalSearchParams<{ flowId?: string | string[] }>();
  const flowId = typeof params.flowId === 'string' ? params.flowId : undefined;
  const draft = useFlowDraft(flowId);
  if (!flowId || draft?.kind !== 'new-space') return <MissingFlow title="Choose Folder" />;
  return <FolderSelection key={`${flowId}:${draft.deviceId}`} flowId={flowId} draft={draft} />;
}

function FolderSelection({ flowId, draft }: { flowId: string; draft: NewSpaceDraft }) {
  const { devices } = useHerdr();
  const { hosts } = useHosts();
  const device = devices[draft.deviceId];
  const session = useHostSession(draft.deviceId);
  const sessionId = device?.connection === 'connected' && session?.status === 'connected' ? session.sessionId : null;
  const directory = useRemoteDirectory({
    hostId: draft.deviceId, sessionId, initialPath: draft.cwd, directoriesOnly: true,
    client: remoteClient, onSessionChange: refreshSessions,
  });
  const selected = useRef(false);
  useFocusEffect(useCallback(() => { selected.current = false; }, []));
  const error = !device ? 'This device is no longer available. Go back and choose another device.'
    : !sessionId ? 'This device is not connected. Folders will reload when it reconnects.' : null;

  return (
    <RemoteFileExplorer title="Choose Folder" hostId={draft.deviceId} sessionId={sessionId}
      hostLabel={hosts.find((host) => host.id === draft.deviceId)?.name ?? draft.deviceId}
      directory={directory} error={error} foldersOnly
      onSelectDirectory={(path, request) => {
        if (selected.current) return;
        const current = flowDrafts.get(flowId);
        if (current?.kind !== 'new-space' || current.deviceId !== draft.deviceId) {
          throw new Error('This form changed. Go back and choose the device again.');
        }
        if (!directory.isCurrent(request) ||
          herdrRepository.getSnapshot().devices[current.deviceId]?.connection !== 'connected') {
          refreshSessions();
          throw new Error('This device disconnected. Reconnect and try again.');
        }
        selected.current = true;
        try {
          flowDrafts.update(flowId, (value) => value.kind === 'new-space' && value.deviceId === current.deviceId
            ? { ...value, cwd: path === '~' ? '~/' : path } : value);
          router.back();
          directory.cancel();
        } catch (cause) {
          selected.current = false;
          throw cause;
        }
      }} />
  );
}
