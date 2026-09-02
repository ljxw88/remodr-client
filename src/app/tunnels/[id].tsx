import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { Screen } from '@/components/ui/screen';
import { TextField } from '@/components/ui/text-field';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import type { TunnelSnapshot } from '@/domain/remote';
import { useHostSession } from '@/features/connection/use-host-session';
import { useTheme } from '@/hooks/use-theme';
import { remoteClient } from '@/services/native-remote-client';
import { toUserMessage } from '@/utils/user-error';

export default function TunnelsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const session = useHostSession(id ?? '');
  const [bindPort, setBindPort] = useState('18080');
  const [destHost, setDestHost] = useState('127.0.0.1');
  const [destPort, setDestPort] = useState('80');
  const [tunnels, setTunnels] = useState<TunnelSnapshot[]>(() =>
    session ? remoteClient.listForwards(session.sessionId) : [],
  );

  const load = useCallback(() => {
    if (!session) {
      return;
    }
    setTunnels(remoteClient.listForwards(session.sessionId));
  }, [session]);

  if (!session) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Tunnels' }} />
        <ThemedText>Connect to this host first.</ThemedText>
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Local forward' }} />
      <View style={styles.form}>
        <View style={styles.section}>
          <ThemedText type="section">New tunnel</ThemedText>
          <View
            style={[
              styles.card,
              { backgroundColor: theme.backgroundElement, borderColor: theme.border },
            ]}>
            <TextField label="Local port" value={bindPort} onChangeText={setBindPort} keyboardType="number-pad" />
            <TextField label="Destination host" value={destHost} onChangeText={setDestHost} />
            <TextField label="Destination port" value={destPort} onChangeText={setDestPort} keyboardType="number-pad" />
            <AppButton
              label="Start tunnel"
              onPress={() => {
                void (async () => {
                  try {
                    await remoteClient.openLocalForward(
                      session.sessionId,
                      '127.0.0.1',
                      Number(bindPort),
                      destHost,
                      Number(destPort),
                    );
                    load();
                  } catch (error) {
                    Alert.alert('Tunnel', toUserMessage(error));
                  }
                })();
              }}
            />
          </View>
        </View>
        <ThemedText type="section">Active tunnels</ThemedText>
        {tunnels.map((tunnel) => (
          <View
            key={tunnel.id}
            style={[
              styles.item,
              { backgroundColor: theme.backgroundElement, borderColor: theme.border },
            ]}>
            <ThemedText>
              {tunnel.bindHost}:{tunnel.bindPort} → {tunnel.destHost}:{tunnel.destPort}
            </ThemedText>
            <AppButton
              label="Close"
              variant="secondary"
              onPress={() => {
                void remoteClient.closeForward(tunnel.id).then(load);
              }}
            />
          </View>
        ))}
        {tunnels.length === 0 ? (
          <ThemedText type="small" themeColor="textMuted">
            No active tunnels.
          </ThemedText>
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: Spacing.three,
  },
  section: {
    gap: Spacing.two,
  },
  card: {
    gap: Spacing.two,
    padding: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.control,
  },
  item: {
    gap: Spacing.two,
    padding: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.control,
  },
});
