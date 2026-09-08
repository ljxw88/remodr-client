import { useState, type ReactNode } from 'react';
import { Animated, Keyboard, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { AppButton } from '@/components/ui/app-button';
import { AppIcon } from '@/components/ui/app-icon';
import { FormError, FormPage, FormSection, SelectionRow, SelectionRowSkeleton } from '@/components/ui/form-page';
import { TextField } from '@/components/ui/text-field';
import { ControlHeight, Radius, Spacing } from '@/constants/theme';
import type { RemoteFile } from '@/domain/remote';
import {
  childRemoteFolderPath,
  normalizeRemoteFolderPath,
  parentRemoteFolderPath,
} from '@/features/files/remote-folder-path';
import { useCachedListing } from '@/features/files/use-cached-listing';
import type { DirectoryRequest, useRemoteDirectory } from '@/features/files/use-remote-directory';
import { useContentReveal } from '@/hooks/use-content-reveal';
import { useTheme } from '@/hooks/use-theme';
import { toUserMessage } from '@/utils/user-error';

const LOADING_ROWS = ['0', '1', '2', '3'];
const EMPTY_ROWS: RemoteFile[] = [];
type ExplorerRow = RemoteFile | string;

type Props = {
  title: string;
  hostId: string;
  hostLabel: string;
  sessionId: string | null;
  directory: ReturnType<typeof useRemoteDirectory>;
  error?: string | null;
  foldersOnly?: boolean;
  onSelectDirectory?: (path: string, request: DirectoryRequest) => void;
  onFileActions?: (file: RemoteFile, request: DirectoryRequest) => void;
  renderActions?: (enabled: boolean) => ReactNode;
};

export function RemoteFileExplorer({
  title, hostId, hostLabel, sessionId, directory, error: connectionError = null,
  foldersOnly = false, onSelectDirectory, onFileActions, renderActions,
}: Props) {
  const theme = useTheme();
  const { path, loading, ready } = directory;
  const viewRequest = directory.request;
  const [entry, setEntry] = useState(() => path === '~' ? '~/' : path);
  const [selectionFailure, setSelectionFailure] = useState<{
    hostId: string; path: string; sessionId: string | null; message: string;
  } | null>(null);
  const cache = useCachedListing({
    hostId, sessionId, path, ready, entries: directory.entries,
  });
  const selectionError = selectionFailure?.hostId === hostId && selectionFailure.path === path && selectionFailure.sessionId === sessionId
    ? selectionFailure.message : null;
  const error = selectionError ?? connectionError ?? directory.error ??
    (sessionId ? null : 'This device is not connected. Reconnect to browse files.');
  const unopenedPath = !entry.trim() || normalizeRemoteFolderPath(entry) !== path;
  const parent = parentRemoteFolderPath(path);
  const enabled = Boolean(sessionId && ready && !loading && !error && !unopenedPath);
  const initialLoading = !unopenedPath && !error && !cache.available;
  const revealStyle = useContentReveal(initialLoading, JSON.stringify([hostId, sessionId, path]));
  const rows: ExplorerRow[] = unopenedPath || (error && !cache.available)
    ? EMPTY_ROWS : initialLoading ? LOADING_ROWS : cache.entries;

  function setSelectionError(message: string | null) {
    setSelectionFailure(message == null ? null : { hostId, path, sessionId, message });
  }

  function navigate(nextPath: string) {
    Keyboard.dismiss();
    const normalized = normalizeRemoteFolderPath(nextPath);
    setSelectionError(null);
    setEntry(normalized === '~' ? '~/' : normalized);
    directory.navigate(normalized);
  }

  function retry() {
    Keyboard.dismiss();
    setSelectionError(null);
    setEntry(path === '~' ? '~/' : path);
    directory.refresh();
  }

  function openAddress() {
    if (entry.trim()) navigate(entry);
  }

  function useFolder() {
    if (!enabled || !onSelectDirectory) return;
    try {
      if (!viewRequest || !directory.isCurrent(viewRequest)) {
        setSelectionError('This device disconnected. Reconnect and try again.');
        return;
      }
      onSelectDirectory(path, viewRequest);
    } catch (cause) {
      setSelectionError(toUserMessage(cause));
    }
  }

  return (
    <FormPage title={title} scroll={false} footer={onSelectDirectory ? (
      <>
        {unopenedPath ? <ThemedText type="caption" themeColor="textMuted">Open the entered path before selecting it.</ThemedText> : null}
        <AppButton label="Use this folder" disabled={!enabled} onPress={useFolder} />
      </>
    ) : undefined}>
      <ThemedText type="small" themeColor="textSecondary">{hostLabel}</ThemedText>
      <View style={styles.addressBar}>
        <Pressable accessibilityRole="button" accessibilityLabel="Parent folder"
          accessibilityState={{ disabled: !parent || unopenedPath || !sessionId }} disabled={!parent || unopenedPath || !sessionId}
          onPress={() => { if (parent) navigate(parent); }}
          style={({ pressed }) => [styles.up, {
            backgroundColor: theme.backgroundElement, borderColor: theme.border,
            opacity: !parent || unopenedPath || !sessionId ? 0.4 : pressed ? 0.65 : 1,
          }]}>
          <AppIcon name={{ ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' }}
            size={20} tintColor={theme.textSecondary} fallback="↑" />
        </Pressable>
        <View style={styles.addressField}>
          <TextField label="Folder path" value={entry} onChangeText={(value) => { setEntry(value); setSelectionError(null); }}
            placeholder="~/Projects" autoCapitalize="none" autoCorrect={false}
            returnKeyType="go" onSubmitEditing={openAddress}
            rightAccessory={<Pressable accessibilityRole="button" accessibilityLabel="Open path"
              accessibilityState={{ disabled: !entry.trim() || !sessionId }} disabled={!entry.trim() || !sessionId} onPress={openAddress}
              style={({ pressed }) => [styles.go, { opacity: !entry.trim() || !sessionId ? 0.4 : pressed ? 0.65 : 1 }]}>
              <ThemedText type="smallBold" themeColor="accent">Go</ThemedText>
            </Pressable>} />
        </View>
      </View>
      {renderActions?.(enabled)}
      {!unopenedPath && error && cache.available ? (
        <View style={styles.cachedError}><FormError message={error} /><AppButton label="Try again" variant="secondary" onPress={retry} /></View>
      ) : null}
      <FormSection fill>
        <Animated.FlatList<ExplorerRow> data={rows}
          keyExtractor={(item) => typeof item === 'string' ? `loading-${item}` : item.path}
          style={[styles.list, revealStyle]} keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag" showsVerticalScrollIndicator={false}
          contentContainerStyle={rows.length === 0 ? styles.emptyContent : undefined}
          renderItem={({ item }) => typeof item === 'string'
            ? <SelectionRowSkeleton label={foldersOnly ? 'Loading folders' : 'Loading files'} />
            : (
                <SelectionRow label={item.name} description={item.isDirectory ? 'Folder' : `${item.size} B`}
                  disabled={!enabled}
                  onPress={item.isDirectory ? () => {
                    if (viewRequest && directory.isCurrent(viewRequest)) navigate(childRemoteFolderPath(path, item.name));
                  } : undefined}
                  accessibilityHint={onFileActions ? 'Long press for file actions' : undefined}
                  onLongPress={onFileActions ? () => {
                    if (viewRequest && directory.isCurrent(viewRequest)) onFileActions(item, viewRequest);
                  } : undefined} />
            )}
          ListEmptyComponent={
            <View style={styles.center}>
              {unopenedPath ? <ThemedText type="small" themeColor="textMuted">Tap Go to browse this path.</ThemedText>
                : error && !cache.available ? <><FormError message={error} /><AppButton label="Try again" variant="secondary" onPress={retry} /></>
                  : <ThemedText type="small" themeColor="textMuted">{foldersOnly ? 'No folders here.' : 'This folder is empty.'}</ThemedText>}
            </View>
          } />
      </FormSection>
    </FormPage>
  );
}

const styles = StyleSheet.create({
  addressBar: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.one },
  addressField: { flex: 1 },
  up: { width: ControlHeight.regular, height: ControlHeight.regular, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.control, borderWidth: StyleSheet.hairlineWidth },
  go: { minWidth: ControlHeight.compact, height: ControlHeight.compact, alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.two, paddingVertical: Spacing.two },
  cachedError: { gap: Spacing.one },
  list: { flex: 1 },
  emptyContent: { flexGrow: 1 },
});
