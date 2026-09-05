import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Keyboard, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { AppButton } from '@/components/ui/app-button';
import { AppIcon } from '@/components/ui/app-icon';
import { FormError, FormPage, FormSection, MissingFlow, SelectionRow } from '@/components/ui/form-page';
import { TextField } from '@/components/ui/text-field';
import { ControlHeight, Radius, Spacing } from '@/constants/theme';
import type { RemoteFile } from '@/domain/remote';
import { useHerdr } from '@/features/agents/use-herdr';
import { refreshSessions, useHostSession } from '@/features/connection/use-host-session';
import {
  childRemoteFolderPath,
  normalizeRemoteFolderPath,
  parentRemoteFolderPath,
  remoteFolderSftpPath,
} from '@/features/files/remote-folder-path';
import { flowDrafts, useFlowDraft, type NewSpaceDraft } from '@/features/forms/flow-drafts';
import { useHosts } from '@/features/hosts/use-hosts';
import { useTheme } from '@/hooks/use-theme';
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
  if (!flowId || draft?.kind !== 'new-space') return <MissingFlow title="Choose Folder" />;
  return <FolderBrowser key={`${flowId}:${draft.deviceId}`} flowId={flowId} draft={draft} />;
}

function FolderBrowser({ flowId, draft }: { flowId: string; draft: NewSpaceDraft }) {
  const theme = useTheme();
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
  const parent = parentRemoteFolderPath(path);

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
    Keyboard.dismiss();
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

  function openAddress() {
    if (entry.trim()) navigate(entry);
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
    <FormPage title="Choose Folder" scroll={false} footer={
      <>
        {unopenedPath ? <ThemedText type="caption" themeColor="textMuted">Open the entered path before selecting it.</ThemedText> : null}
        <AppButton label="Use this folder" disabled={loading || !!error || unopenedPath || !currentListing} onPress={useFolder} />
      </>
    }>
      <ThemedText type="small" themeColor="textSecondary">{hosts.find((host) => host.id === draft.deviceId)?.name ?? draft.deviceId}</ThemedText>
      <View style={styles.addressBar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Parent folder"
          accessibilityState={{ disabled: !parent || unopenedPath }} disabled={!parent || unopenedPath}
          onPress={() => { if (parent) navigate(parent); }}
          style={({ pressed }) => [styles.up, {
            backgroundColor: theme.backgroundElement, borderColor: theme.border,
            opacity: !parent || unopenedPath ? 0.4 : pressed ? 0.65 : 1,
          }]}>
          <AppIcon name={{ ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' }}
            size={20} tintColor={theme.textSecondary} fallback="↑" />
        </Pressable>
        <View style={styles.addressField}>
          <TextField label="Folder path" value={entry} onChangeText={(value) => { setEntry(value); setSelectionError(null); }}
            placeholder="~/Projects" autoCapitalize="none" autoCorrect={false}
            returnKeyType="go" onSubmitEditing={openAddress}
            rightAccessory={<Pressable accessibilityRole="button" accessibilityLabel="Open path"
              accessibilityState={{ disabled: !entry.trim() }} disabled={!entry.trim()} onPress={openAddress}
              style={({ pressed }) => [styles.go, { opacity: !entry.trim() ? 0.4 : pressed ? 0.65 : 1 }]}>
              <ThemedText type="smallBold" themeColor="accent">Go</ThemedText>
            </Pressable>} />
        </View>
      </View>
      {unopenedPath ? <View style={styles.center}><ThemedText type="small" themeColor="textMuted">Tap Go to browse this path.</ThemedText></View>
        : loading ? <View style={styles.center}><ActivityIndicator /><ThemedText type="small" themeColor="textMuted">Loading folders…</ThemedText></View>
        : error ? <View style={styles.center}><FormError message={error} /><AppButton label="Try again" variant="secondary" onPress={retry} /></View>
          : <FormSection fill>
            <FlatList data={currentListing?.folders ?? []} keyExtractor={(folder) => folder.path}
              style={styles.list} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}
              renderItem={({ item }) => <SelectionRow label={item.name} description="Folder" onPress={() => navigate(childRemoteFolderPath(path, item.name))} />}
              ListEmptyComponent={<View style={styles.center}><ThemedText type="small" themeColor="textMuted">No folders here.</ThemedText></View>} />
          </FormSection>}
    </FormPage>
  );
}

const styles = StyleSheet.create({
  addressBar: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.one },
  addressField: { flex: 1 },
  up: { width: ControlHeight.regular, height: ControlHeight.regular, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.control, borderWidth: StyleSheet.hairlineWidth },
  go: { minWidth: ControlHeight.compact, height: ControlHeight.compact, alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.two, paddingVertical: Spacing.two },
  list: { flex: 1 },
});
