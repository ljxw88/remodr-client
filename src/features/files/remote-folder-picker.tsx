import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppButton } from '@/components/ui/app-button';
import { AppIcon } from '@/components/ui/app-icon';
import { RemotePathBar } from '@/features/files/remote-path-bar';
import { SheetPanel } from '@/components/ui/sheet';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import type { RemoteFile } from '@/domain/remote';
import {
  childRemoteFolderPath,
  normalizeRemoteFolderPath,
  parentRemoteFolderPath,
  remoteFolderSftpPath,
} from '@/features/files/remote-folder-path';
import { useTheme } from '@/hooks/use-theme';
import { remoteClient } from '@/services/native-remote-client';
import { toUserMessage } from '@/utils/user-error';

type Props = {
  deviceId: string;
  deviceName: string;
  initialPath: string;
  onClose: () => void;
  onSelect: (path: string) => void;
};

export function RemoteFolderPicker({
  deviceId,
  deviceName,
  initialPath,
  onClose,
  onSelect,
}: Props) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const sessionId = remoteClient.getSession(deviceId)?.sessionId ?? null;
  const [path, setPath] = useState(() => normalizeRemoteFolderPath(initialPath));
  const [folders, setFolders] = useState<RemoteFile[]>([]);
  const [loading, setLoading] = useState(sessionId != null);
  const [error, setError] = useState<string | null>(
    sessionId ? null : 'This device is no longer connected.',
  );
  const [reloadKey, setReloadKey] = useState(0);
  const parent = parentRemoteFolderPath(path);

  useEffect(() => {
    let active = true;
    if (!sessionId) {
      return;
    }
    void remoteClient
      .sftpList(sessionId, remoteFolderSftpPath(path))
      .then((entries) => {
        if (!active) {
          return;
        }
        setFolders(
          entries
            .filter(
              (entry) =>
                entry.isDirectory && entry.name !== '.' && entry.name !== '..',
            )
            .sort((left, right) => {
              const hiddenOrder =
                Number(left.name.startsWith('.')) -
                Number(right.name.startsWith('.'));
              return hiddenOrder || left.name.localeCompare(right.name);
            }),
        );
        setError(null);
      })
      .catch((cause) => {
        if (active) {
          setError(toUserMessage(cause));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [path, reloadKey, sessionId]);

  const navigate = useCallback((nextPath: string) => {
    setLoading(true);
    setPath(nextPath);
  }, []);

  return (
    <SheetPanel
      style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, Spacing.two) }]}>
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <ThemedText type="heading">Choose folder</ThemedText>
              <ThemedText type="caption" themeColor="textSecondary">
                {deviceName}
              </ThemedText>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back to New space"
              onPress={onClose}
              style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
              <AppIcon
                name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }}
                size={20}
                tintColor={theme.textSecondary}
                fallback="‹"
              />
            </Pressable>
          </View>

          <RemotePathBar path={path} parent={parent} onNavigate={navigate} />

          {loading ? (
            <View style={styles.center}>
              <ActivityIndicator color={theme.accent} />
              <ThemedText type="small" themeColor="textMuted">
                Loading folders
              </ThemedText>
            </View>
          ) : error ? (
            <View style={styles.center}>
              <ThemedText type="small" themeColor="danger">
                {error}
              </ThemedText>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry folder list"
                onPress={() => {
                  if (!remoteClient.getSession(deviceId)) {
                    setError('This device is no longer connected.');
                    setLoading(false);
                    return;
                  }
                  setLoading(true);
                  setReloadKey((current) => current + 1);
                }}>
                <ThemedText type="smallBold" style={{ color: theme.accent }}>
                  Try again
                </ThemedText>
              </Pressable>
            </View>
          ) : (
            <FlatList
              data={folders}
              keyExtractor={(folder) => folder.path}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.list}
              renderItem={({ item }) => (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${item.name}, folder`}
                  onPress={() =>
                    navigate(childRemoteFolderPath(path, item.name))
                  }
                  style={({ pressed }) => [
                    styles.folder,
                    {
                      backgroundColor: theme.backgroundElement,
                      borderColor: theme.border,
                      opacity: pressed ? 0.68 : 1,
                    },
                  ]}>
                  <View style={[styles.folderIcon, { backgroundColor: theme.accentSoft }]}>
                    <AppIcon
                      name={{ ios: 'folder', android: 'folder', web: 'folder' }}
                      size={20}
                      tintColor={theme.accent}
                      fallback="□"
                    />
                  </View>
                  <ThemedText type="smallBold" numberOfLines={1} style={styles.folderName}>
                    {item.name}
                  </ThemedText>
                  <AppIcon
                    name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
                    size={17}
                    tintColor={theme.textMuted}
                    fallback="›"
                  />
                </Pressable>
              )}
              ListEmptyComponent={
                <View style={styles.center}>
                  <ThemedText type="small" themeColor="textMuted">
                    No folders here.
                  </ThemedText>
                </View>
              }
            />
          )}

          <AppButton
            label="Use this folder"
            onPress={() => onSelect(path === '~' ? '~/' : path)}
          />
    </SheetPanel>
  );
}

const styles = StyleSheet.create({
  sheet: {
    height: '88%',
    gap: Spacing.two,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  headerCopy: {
    flex: 1,
    gap: 2,
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.pill,
  },
  list: {
    gap: Spacing.one,
    paddingBottom: Spacing.one,
  },
  folder: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + Spacing.half,
    paddingHorizontal: Spacing.one + Spacing.half,
    borderWidth: 1,
    borderRadius: Radius.control,
  },
  folderIcon: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 11,
  },
  folderName: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
    paddingVertical: Spacing.four,
  },
  pressed: {
    opacity: 0.6,
  },
});
