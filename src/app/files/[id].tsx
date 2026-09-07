import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { AppIcon } from '@/components/ui/app-icon';
import { NeedsSession } from '@/components/ui/needs-session';
import { RemotePathBar } from '@/features/files/remote-path-bar';
import { Screen } from '@/components/ui/screen';
import { TextField } from '@/components/ui/text-field';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import {
  childRemoteFolderPath,
  isValidRemoteFolderName,
  parentRemoteFolderPath,
  remoteFolderSftpPath,
} from '@/features/files/remote-folder-path';
import { refreshSessions, useHostSession } from '@/features/connection/use-host-session';
import { useRemoteDirectory } from '@/features/files/use-remote-directory';
import { useTheme } from '@/hooks/use-theme';
import { remoteClient } from '@/services/native-remote-client';
import { toUserMessage } from '@/utils/user-error';

export default function FilesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const session = useHostSession(id ?? '');
  const sessionId = session?.status === 'connected' ? session.sessionId : null;
  const directory = useRemoteDirectory({
    hostId: id ?? '', sessionId, client: remoteClient, onSessionChange: refreshSessions,
  });
  const { path, navigate } = directory;
  const viewRequest = directory.request;
  const [name, setName] = useState('');
  const parent = parentRemoteFolderPath(path);
  const canCreateFolder = isValidRemoteFolderName(name);

  if (!sessionId) {
    return <NeedsSession title="Files" />;
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Files' }} />
      <View style={styles.toolbar}>
        <RemotePathBar path={path} parent={parent} onNavigate={navigate} />
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
                  if (!viewRequest || !directory.isCurrent(viewRequest)) {
                    Alert.alert('Folder changed', 'The folder or connection changed. Try again.');
                    return;
                  }
                  const submittedName = name.trim();
                  const folderPath = childRemoteFolderPath(path, submittedName);
                  await remoteClient.sftpMkdir(
                    viewRequest.sessionId,
                    remoteFolderSftpPath(folderPath),
                  );
                  if (directory.capture() === viewRequest) {
                    setName((current) => current.trim() === submittedName ? '' : current);
                  }
                  directory.refresh(viewRequest);
                } catch (error) {
                  Alert.alert('Could not create folder', toUserMessage(error));
                }
              })();
            }}
          />
        </View>
      </View>
      <FlatList
        data={directory.entries}
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
              if (item.isDirectory && directory.capture() === viewRequest) {
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
                    void (async () => {
                      try {
                        if (!viewRequest || !directory.isCurrent(viewRequest)) {
                          Alert.alert('Folder changed', 'The folder or connection changed. Try again.');
                          return;
                        }
                        await remoteClient.sftpRemove(viewRequest.sessionId, item.path);
                        directory.refresh(viewRequest);
                      } catch (error) {
                        Alert.alert('Could not delete item', toUserMessage(error));
                      }
                    })();
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
            {directory.loading ? (
              <ActivityIndicator accessibilityLabel="Loading files" />
            ) : directory.error ? (
              <>
                <ThemedText type="small" themeColor="textMuted">{directory.error}</ThemedText>
                <AppButton label="Try again" variant="secondary" onPress={() => directory.refresh()} />
              </>
            ) : (
              <ThemedText type="small" themeColor="textMuted">This folder is empty.</ThemedText>
            )}
          </View>
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    gap: Spacing.two,
    marginBottom: Spacing.three,
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
