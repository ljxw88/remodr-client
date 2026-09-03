import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, FlatList, StyleSheet, View } from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { NeedsSession } from '@/components/ui/needs-session';
import { Screen } from '@/components/ui/screen';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useHostSession } from '@/features/connection/use-host-session';
import { useTheme } from '@/hooks/use-theme';
import { parseDockerPs, type DockerContainer } from '@/services/parsers';
import { remoteClient } from '@/services/native-remote-client';
import { toUserMessage } from '@/utils/user-error';

export default function DockerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const session = useHostSession(id ?? '');
  const [containers, setContainers] = useState<DockerContainer[]>([]);

  useEffect(() => {
    if (!session) {
      return;
    }
    let active = true;
    void remoteClient
      .exec(
        session.sessionId,
        "docker ps -a --format '{{.ID}}\t{{.Image}}\t{{.Status}}\t{{.Names}}'",
      )
      .then((result) => {
        if (active) {
          setContainers(parseDockerPs(result.stdout));
        }
      })
      .catch((error) => {
        if (active) {
          Alert.alert('Docker', toUserMessage(error));
        }
      });
    return () => {
      active = false;
    };
  }, [session]);

  if (!session) {
    return <NeedsSession title="Docker" />;
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Docker' }} />
      <FlatList
        data={containers}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View
            style={[
              styles.card,
              { backgroundColor: theme.backgroundElement, borderColor: theme.border },
            ]}>
            <View style={styles.cardHeader}>
              <ThemedText type="section" style={styles.name}>
                {item.names}
              </ThemedText>
              <View style={[styles.status, { borderColor: theme.border }]}>
                <ThemedText type="caption" themeColor="textMuted">
                  {item.status}
                </ThemedText>
              </View>
            </View>
            <ThemedText type="caption" themeColor="textSecondary" numberOfLines={1}>
              {item.image}
            </ThemedText>
            <AppButton
              label="Logs"
              variant="secondary"
              onPress={() => {
                void remoteClient.exec(session.sessionId, `docker logs --tail 80 ${item.id}`).then((result) => {
                  Alert.alert(item.names, result.stdout.slice(0, 1500) || result.stderr);
                });
              }}
            />
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <ThemedText type="small" themeColor="textMuted">
              No containers found.
            </ThemedText>
          </View>
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: {
    gap: Spacing.two,
    paddingBottom: Spacing.four,
  },
  card: {
    gap: Spacing.two,
    padding: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.control,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  name: {
    flex: 1,
  },
  status: {
    maxWidth: '50%',
    paddingHorizontal: Spacing.one,
    paddingVertical: 3,
    borderWidth: 1,
    borderRadius: Radius.tag,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: Spacing.four,
  },
});
