import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { TextField } from '@/components/ui/text-field';
import { Spacing } from '@/constants/theme';
import { refreshSessions, useHostSession } from '@/features/connection/use-host-session';
import { RemoteFileExplorer } from '@/features/files/remote-file-explorer';
import { childRemoteFolderPath, isValidRemoteFolderName, remoteFolderSftpPath } from '@/features/files/remote-folder-path';
import { useRemoteDirectory } from '@/features/files/use-remote-directory';
import { useHosts } from '@/features/hosts/use-hosts';
import { remoteClient } from '@/services/native-remote-client';
import { toUserMessage } from '@/utils/user-error';

export default function FilesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { hosts } = useHosts();
  const session = useHostSession(id ?? '');
  const sessionId = session?.status === 'connected' ? session.sessionId : null;
  const directory = useRemoteDirectory({
    hostId: id ?? '', sessionId, client: remoteClient, onSessionChange: refreshSessions,
  });
  const [name, setName] = useState('');
  const request = directory.request;

  async function createFolder(enabled: boolean) {
    try {
      if (!isValidRemoteFolderName(name)) {
        Alert.alert('Invalid folder name', 'Use one folder name without slashes or parent-directory segments.');
        return;
      }
      if (!enabled || !request || !directory.isCurrent(request)) {
        Alert.alert('Folder changed', 'The folder or connection changed. Try again.');
        return;
      }
      const submittedName = name.trim();
      const path = childRemoteFolderPath(directory.path, submittedName);
      await remoteClient.sftpMkdir(request.sessionId, remoteFolderSftpPath(path));
      if (directory.capture() === request) {
        setName((current) => current.trim() === submittedName ? '' : current);
      }
      directory.refresh(request);
    } catch (error) {
      Alert.alert('Could not create folder', toUserMessage(error));
    }
  }

  return (
    <RemoteFileExplorer key={id} title="Files" hostId={id ?? ''} sessionId={sessionId}
      hostLabel={hosts.find((host) => host.id === id)?.name ?? id ?? 'Server'}
      directory={directory}
      error={sessionId ? null : 'Connect to this host first. Files will reload when it reconnects.'}
      renderActions={(enabled) => (
        <View style={styles.newFolder}>
          <View style={styles.folderField}><TextField label="New folder" value={name} onChangeText={setName} /></View>
          <AppButton label="Create" variant="secondary" disabled={!enabled || !isValidRemoteFolderName(name)}
            onPress={() => { void createFolder(enabled); }} />
        </View>
      )}
      onFileActions={(item, capturedRequest) => {
        Alert.alert(item.name, undefined, [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete', style: 'destructive',
            onPress: () => {
              void (async () => {
                try {
                  if (!directory.isCurrent(capturedRequest)) {
                    Alert.alert('Folder changed', 'The folder or connection changed. Try again.');
                    return;
                  }
                  await remoteClient.sftpRemove(capturedRequest.sessionId, item.path);
                  directory.refresh(capturedRequest);
                } catch (error) {
                  Alert.alert('Could not delete item', toUserMessage(error));
                }
              })();
            },
          },
        ]);
      }} />
  );
}

const styles = StyleSheet.create({
  newFolder: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.one },
  folderField: { flex: 1 },
});
