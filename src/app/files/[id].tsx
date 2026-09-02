import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { AppIcon } from '@/components/ui/app-icon';
import { Screen } from '@/components/ui/screen';
import { TextField } from '@/components/ui/text-field';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import type { RemoteFile } from '@/domain/remote';
import { useHostSession } from '@/features/connection/use-host-session';
import { useTheme } from '@/hooks/use-theme';
import { remoteClient } from '@/services/native-remote-client';
import { toUserMessage } from '@/utils/user-error';

export default function FilesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const session = useHostSession(id ?? '');
  const [path, setPath] = useState('.');
  const [files, setFiles] = useState<RemoteFile[]>([]);
  const [name, setName] = useState('');

  const load = useCallback(async () => {
    if (!session) {
      return;
    }
    try {
      setFiles(await remoteClient.sftpList(session.sessionId, path));
    } catch (error) {
      Alert.alert('SFTP', toUserMessage(error));
    }
  }, [path, session]);

  useEffect(() => {
    if (!session) {
      return;
    }
    let active = true;
    void remoteClient
      .sftpList(session.sessionId, path)
      .then((nextFiles) => {
        if (active) {
          setFiles(nextFiles);
        }
      })
      .catch((error) => {
        if (active) {
          Alert.alert('SFTP', toUserMessage(error));
        }
      });
    return () => {
      active = false;
    };
  }, [path, session]);

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
        <View
          style={[
            styles.path,
            { backgroundColor: theme.fog, borderColor: theme.border },
          ]}>
          <AppIcon
            name={{ ios: 'folder', android: 'folder', web: 'folder' }}
            size={18}
            tintColor={theme.textMuted}
            fallback="□"
          />
          <ThemedText type="caption" numberOfLines={1} style={styles.pathText}>
            {path}
          </ThemedText>
        </View>
        <View style={styles.newFolder}>
          <View style={styles.folderField}>
            <TextField label="New folder" value={name} onChangeText={setName} />
          </View>
          <AppButton
            label="Create"
            variant="secondary"
            onPress={() => {
              void (async () => {
                await remoteClient.sftpMkdir(session.sessionId, `${path}/${name}`);
                setName('');
                await load();
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
            onPress={() => {
              if (item.isDirectory) {
                setPath(item.path);
              }
            }}
            onLongPress={() => {
              Alert.alert(item.name, undefined, [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: () => {
                    void remoteClient.sftpRemove(session.sessionId, item.path).then(load);
                  },
                },
              ]);
            }}
            style={[
              styles.file,
              { borderColor: theme.border, backgroundColor: theme.backgroundElement },
            ]}>
            <AppIcon
              name={{
                ios: item.isDirectory ? 'folder' : 'doc',
                android: item.isDirectory ? 'folder' : 'draft',
                web: item.isDirectory ? 'folder' : 'draft',
              }}
              size={20}
              tintColor={theme.text}
              fallback="□"
            />
            <ThemedText type="small" style={styles.fileName} numberOfLines={1}>
              {item.name}
            </ThemedText>
            <ThemedText type="caption" themeColor="textMuted">
              {item.isDirectory ? 'Folder' : `${item.size} B`}
            </ThemedText>
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

const styles = StyleSheet.create({
  toolbar: {
    gap: Spacing.two,
    marginBottom: Spacing.three,
  },
  path: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
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
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.control,
    paddingHorizontal: Spacing.two,
  },
  fileName: {
    flex: 1,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: Spacing.four,
  },
});
