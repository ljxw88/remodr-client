import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { AppButton } from '@/components/ui/app-button';
import { FormError, FormPage, MissingFlow, SelectionRow } from '@/components/ui/form-page';
import { TextField } from '@/components/ui/text-field';
import { Spacing } from '@/constants/theme';
import type { RemoteFile } from '@/domain/remote';
import { useHerdr } from '@/features/agents/use-herdr';
import { refreshSessions, useHostSession } from '@/features/connection/use-host-session';
import {
  childRemoteFolderPath,
  normalizeRemoteFolderPath,
  parentRemoteFolderPath,
  remoteFolderSftpPath,
} from '@/features/files/remote-folder-path';
import { RemotePathBar } from '@/features/files/remote-path-bar';
import { flowDrafts, useFlowDraft, type NewSpaceDraft } from '@/features/forms/flow-drafts';
import { useHosts } from '@/features/hosts/use-hosts';
import { herdrRepository } from '@/services/herdr-repository';
import { remoteClient } from '@/services/native-remote-client';
import { toUserMessage } from '@/utils/user-error';

type Listing = {
  path: string;
  sessionId: string;
  revision: number;
  folders: RemoteFile[];
  error: string | null;
};

export default function FoldersPage() {
  const params = useLocalSearchParams<{ flowId?: string | string[] }>();
  const flowId = typeof params.flowId === 'string' ? params.flowId : undefined;
  const draft = useFlowDraft(flowId);
  if (!flowId || draft?.kind !== 'new-space') return <MissingFlow title="Choose folder" />;
  return <FolderBrowser key={`${flowId}:${draft.deviceId}`} flowId={flowId} draft={draft} />;
}

function FolderBrowser({ flowId, draft }: { flowId: string; draft: NewSpaceDraft }) {
  const { devices } = useHerdr();
  const { hosts } = useHosts();
  const device = devices[draft.deviceId];
  const session = useHostSession(draft.deviceId);
  const sessionId = device?.connection === 'connected' && session?.status === 'connected' ? session.sessionId : null;
  const [path, setPath] = useState(() => normalizeRemoteFolderPath(draft.cwd));
  const [entry, setEntry] = useState(() => path === '~' ? '~/' : path);
  const [revision, setRevision] = useState(0);
  const [listing, setListing] = useState<Listing | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const generation = useRef(0);
  const selected = useRef(false);
  const currentListing = listing?.path === path && listing.sessionId === sessionId && listing.revision === revision ? listing : null;
  const connectionError = !device ? 'This device is no longer available. Go back and choose another device.'
    : !sessionId ? 'This device is not connected. Folders will reload when it reconnects.' : null;
  const loading = !!sessionId && !currentListing;
  const error = selectionError ?? connectionError ?? currentListing?.error;
  const unopenedPath = !entry.trim() || normalizeRemoteFolderPath(entry) !== path;

  useFocusEffect(useCallback(() => {
    const token = ++generation.current;
    selected.current = false;
    setSelectionError(null);
    setListing(null);
    if (!sessionId) return;
    let active = true;
    void remoteClient.sftpList(sessionId, remoteFolderSftpPath(path))
      .then((entries) => {
        if (!active || generation.current !== token) return;
        const live = remoteClient.getSession(draft.deviceId);
        if (live?.sessionId !== sessionId || live.status !== 'connected') {
          refreshSessions();
          return;
        }
        setListing({
          path, sessionId, revision, error: null,
          folders: entries.filter((item) => item.isDirectory && item.name !== '.' && item.name !== '..')
            .sort((left, right) => Number(left.name.startsWith('.')) - Number(right.name.startsWith('.')) || left.name.localeCompare(right.name)),
        });
      })
      .catch((cause) => {
        if (active && generation.current === token) {
          setListing({ path, sessionId, revision, folders: [], error: toUserMessage(cause) });
        }
      });
    return () => {
      active = false;
      generation.current++;
    };
  }, [draft.deviceId, path, revision, sessionId]));

  function navigate(nextPath: string) {
    if (selected.current) return;
    generation.current++;
    const normalized = normalizeRemoteFolderPath(nextPath);
    setSelectionError(null);
    setListing(null);
    setEntry(normalized === '~' ? '~/' : normalized);
    setPath(normalized);
    setRevision((value) => value + 1);
  }

  function retry() {
    refreshSessions();
    navigate(path);
  }

  function useFolder() {
    if (selected.current || loading || error || unopenedPath || !currentListing || !sessionId) return;
    const current = flowDrafts.get(flowId);
    if (current?.kind !== 'new-space' || current.deviceId !== draft.deviceId) return;
    try {
      const live = remoteClient.getSession(current.deviceId);
      if (live?.sessionId !== sessionId || live.status !== 'connected' ||
        herdrRepository.getSnapshot().devices[current.deviceId]?.connection !== 'connected') {
        refreshSessions();
        setSelectionError('This device disconnected. Reconnect and try again.');
        return;
      }
      selected.current = true;
      generation.current++;
      flowDrafts.update(flowId, (value) => value.kind === 'new-space' && value.deviceId === current.deviceId
        ? { ...value, cwd: path === '~' ? '~/' : path } : value);
      router.back();
    } catch (cause) {
      selected.current = false;
      setSelectionError(toUserMessage(cause));
    }
  }

  return (
    <FormPage title="Choose folder" scroll={false} footer={
      <>
        {unopenedPath ? <ThemedText type="caption" themeColor="textMuted">Open the entered path before selecting it.</ThemedText> : null}
        <AppButton label="Use this folder" disabled={loading || !!error || unopenedPath || !currentListing} onPress={useFolder} />
      </>
    }>
      <ThemedText type="small" themeColor="textSecondary">{hosts.find((host) => host.id === draft.deviceId)?.name ?? draft.deviceId}</ThemedText>
      <TextField label="Folder path" value={entry} onChangeText={(value) => { setEntry(value); setSelectionError(null); }}
        placeholder="~/Projects" autoCapitalize="none" autoCorrect={false}
        returnKeyType="go" onSubmitEditing={() => { if (entry.trim()) navigate(entry); }} />
      <AppButton label="Open path" variant="secondary" disabled={!entry.trim()} onPress={() => navigate(entry)} />
      <RemotePathBar path={path} parent={parentRemoteFolderPath(path)} onNavigate={navigate} />
      {loading ? <View style={styles.center}><ActivityIndicator /><ThemedText type="small" themeColor="textMuted">Loading folders…</ThemedText></View>
        : error ? <View style={styles.center}><FormError message={error} /><AppButton label="Try again" variant="secondary" onPress={retry} /></View>
          : <FlatList data={currentListing?.folders ?? []} keyExtractor={(folder) => folder.path}
            style={styles.list} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
            renderItem={({ item }) => <SelectionRow label={item.name} description="Folder" onPress={() => navigate(childRemoteFolderPath(path, item.name))} />}
            ListEmptyComponent={<View style={styles.center}><ThemedText type="small" themeColor="textMuted">No folders here.</ThemedText></View>} />}
    </FormPage>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.two, paddingVertical: Spacing.two },
  list: { flex: 1 },
});
