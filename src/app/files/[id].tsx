import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { AppIcon } from '@/components/ui/app-icon';
import { Screen } from '@/components/ui/screen';
import { TextField } from '@/components/ui/text-field';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import type { RemoteFile } from '@/domain/remote';
import {
  childRemoteFolderPath,
  isValidRemoteFolderName,
  parentRemoteFolderPath,
  remoteFolderSftpPath,
} from '@/features/files/remote-folder-path';
import { useHostSession } from '@/features/connection/use-host-session';
import { useTheme } from '@/hooks/use-theme';
import { remoteClient } from '@/services/native-remote-client';
import { toUserMessage } from '@/utils/user-error';

export default function FilesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const session = useHostSession(id ?? '');
  const [path, setPath] = useState('~');
  const currentPath = useRef('~');
  const loadVersion = useRef(0);
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [name, setName] = useState('');
  const parent = parentRemoteFolderPath(path);
  const canCreateFolder = isValidRemoteFolderName(name);

  const navigate = useCallback((nextPath: string) => {
    currentPath.current = nextPath;
    setPath(nextPath);
  }, []);

  const commitFiles = useCallback(
    (
      requestedPath: string,
      requestedSessionId: string,
      version: number,
      nextFiles: RemoteFile[],
    ) => {
      if (
        remoteClient.getSession(id ?? '')?.sessionId === requestedSessionId &&
        version === loadVersion.current &&
        currentPath.current === requestedPath
      ) {
        setFiles(nextFiles);
      }
    },
    [id],
  );

  const reportLoadError = useCallback(
    (
      requestedPath: string,
      requestedSessionId: string,
      version: number,
      error: unknown,
    ) => {
      if (
        remoteClient.getSession(id ?? '')?.sessionId === requestedSessionId &&
        version === loadVersion.current &&
        currentPath.current === requestedPath
      ) {
        Alert.alert('SFTP', toUserMessage(error));
      }
    },
    [id],
  );

  const load = useCallback(async (requestedPath: string) => {
    if (!session) {
      return;
    }
    const requestedSessionId = session.sessionId;
    if (remoteClient.getSession(id ?? '')?.sessionId !== requestedSessionId) {
      return;
    }
    const version = ++loadVersion.current;
    try {
      const nextFiles = await listRemoteEntries(requestedSessionId, requestedPath);
      commitFiles(requestedPath, requestedSessionId, version, nextFiles);
    } catch (error) {
      reportLoadError(requestedPath, requestedSessionId, version, error);
    }
  }, [commitFiles, id, reportLoadError, session]);

  useEffect(() => {
    if (!session) {
      return;
    }
    const requestedPath = path;
    const requestedSessionId = session.sessionId;
    const version = ++loadVersion.current;
    void listRemoteEntries(requestedSessionId, requestedPath).then(
      (nextFiles) => commitFiles(requestedPath, requestedSessionId, version, nextFiles),
      (error) => reportLoadError(requestedPath, requestedSessionId, version, error),
    );
    return () => {
      loadVersion.current += 1;
    };
  }, [commitFiles, path, reportLoadError, session]);

  if (!session) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Files' }} />
        <ThemedText>Connect to this host first.</ThemedText>
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Files' }} />
      <View style={styles.toolbar}>
        <View style={styles.pathRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Parent folder"
            accessibilityState={{ disabled: parent == null }}
            disabled={parent == null}
            onPress={() => {
              if (parent) {
                navigate(parent);
              }
            }}
            style={({ pressed }) => [
              styles.parentButton,
              {
                backgroundColor: theme.glassStrong,
                borderColor: theme.glassBorder,
                opacity: parent == null ? 0.38 : pressed ? 0.68 : 1,
              },
            ]}>
            <AppIcon
              name={{ ios: 'chevron.up', android: 'arrow_upward', web: 'arrow_upward' }}
              size={19}
              tintColor={theme.textSecondary}
              fallback="↑"
            />
          </Pressable>
          <View
            style={[
              styles.path,
              { backgroundColor: theme.glassStrong, borderColor: theme.glassBorder },
            ]}>
            <AppIcon
              name={{ ios: 'folder', android: 'folder', web: 'folder' }}
              size={18}
              tintColor={theme.accent}
              fallback="□"
            />
            <ThemedText type="code" numberOfLines={1} style={styles.pathText}>
              {path === '~' ? '~/' : path}
            </ThemedText>
          </View>
        </View>
        <View style={styles.newFolder}>
          <View style={styles.folderField}>
            <TextField label="New folder" value={name} onChangeText={setName} />
          </View>
          <AppButton
            label="Create"
            variant="secondary"
            disabled={!canCreateFolder}
            onPress={() => {
              void (async () => {
                try {
                  if (!isValidRemoteFolderName(name)) {
                    Alert.alert(
                      'Invalid folder name',
                      'Use one folder name without slashes or parent-directory segments.',
                    );
                    return;
                  }
                  const mutationPath = path;
                  const folderPath = childRemoteFolderPath(path, name.trim());
                  await remoteClient.sftpMkdir(
                    session.sessionId,
                    remoteFolderSftpPath(folderPath),
                  );
                  setName('');
                  await load(mutationPath);
                } catch (error) {
                  Alert.alert('Could not create folder', toUserMessage(error));
                }
              })();
            }}
          />
        </View>
      </View>
      <FlatList
        data={files}
        keyExtractor={(item) => item.path}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.name}, ${
              item.isDirectory ? 'folder' : `${item.size} bytes`
            }`}
            onPress={() => {
              if (item.isDirectory) {
                navigate(childRemoteFolderPath(path, item.name));
              }
            }}
            onLongPress={() => {
              Alert.alert(item.name, undefined, [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: () => {
                    const mutationPath = path;
                    void remoteClient
                      .sftpRemove(session.sessionId, item.path)
                      .then(() => load(mutationPath))
                      .catch((error) => {
                        Alert.alert('Could not delete item', toUserMessage(error));
                      });
                  },
                },
              ]);
            }}
            style={[
              styles.file,
              {
                borderColor: theme.glassBorder,
                backgroundColor: theme.glassStrong,
              },
            ]}>
            <View
              style={[
                styles.fileIcon,
                {
                  backgroundColor: item.isDirectory
                    ? theme.accentSoft
                    : theme.backgroundSelected,
                },
              ]}>
              <AppIcon
                name={{
                  ios: item.isDirectory ? 'folder' : 'doc',
                  android: item.isDirectory ? 'folder' : 'draft',
                  web: item.isDirectory ? 'folder' : 'draft',
                }}
                size={20}
                tintColor={item.isDirectory ? theme.accent : theme.textSecondary}
                fallback="□"
              />
            </View>
            <ThemedText type="small" style={styles.fileName} numberOfLines={1}>
              {item.name}
            </ThemedText>
            {item.isDirectory ? (
              <AppIcon
                name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
                size={17}
                tintColor={theme.textMuted}
                fallback="›"
              />
            ) : (
              <ThemedText type="caption" themeColor="textMuted">
                {item.size} B
              </ThemedText>
            )}
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <ThemedText type="small" themeColor="textMuted">
              This folder is empty.
            </ThemedText>
          </View>
        }
      />
    </Screen>
  );
}

function sortRemoteEntries(entries: RemoteFile[]): RemoteFile[] {
  return entries
    .filter((entry) => entry.name !== '.' && entry.name !== '..')
    .sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1;
      }
      const hiddenOrder =
        Number(left.name.startsWith('.')) -
        Number(right.name.startsWith('.'));
      return hiddenOrder || left.name.localeCompare(right.name);
    });
}

async function listRemoteEntries(
  sessionId: string,
  path: string,
): Promise<RemoteFile[]> {
  return sortRemoteEntries(
    await remoteClient.sftpList(sessionId, remoteFolderSftpPath(path)),
  );
}

const styles = StyleSheet.create({
  toolbar: {
    gap: Spacing.two,
    marginBottom: Spacing.three,
  },
  pathRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  parentButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: Radius.pill,
  },
  path: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    flex: 1,
    paddingHorizontal: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.control,
  },
  pathText: {
    flex: 1,
  },
  newFolder: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.one,
  },
  folderField: {
    flex: 1,
  },
  list: {
    gap: Spacing.one,
    paddingBottom: Spacing.four,
  },
  file: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + Spacing.half,
    borderWidth: 1,
    borderRadius: Radius.control,
    paddingHorizontal: Spacing.one + Spacing.half,
  },
  fileIcon: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },
  fileName: {
    flex: 1,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: Spacing.four,
  },
});
