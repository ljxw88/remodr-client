import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, Switch, View } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { AppButton } from '@/components/ui/app-button';
import { GlassSurface } from '@/components/ui/glass-surface';
import { Screen } from '@/components/ui/screen';
import { TextField } from '@/components/ui/text-field';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { RemoteOperationError } from '@/domain/errors';
import type { HostProfile } from '@/domain/hosts';
import { connectHost } from '@/features/connection/connect-host';
import { refreshSessions } from '@/features/connection/use-host-session';
import { useTheme } from '@/hooks/use-theme';
import { hostRepository } from '@/services/host-repository';
import { remoteClient } from '@/services/native-remote-client';
import { toUserMessage } from '@/utils/user-error';
import { retryDeviceConnection } from '@/features/agents/connect-runtime';

export default function ConnectScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const [host, setHost] = useState<HostProfile | null>(null);
  const [secret, setSecret] = useState('');
  const [saveSecret, setSaveSecret] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) {
      return;
    }
    void hostRepository.get(id).then(setHost);
  }, [id]);

  async function run(acceptedFingerprint?: string) {
    if (!host) {
      return;
    }
    setBusy(true);
    try {
      await connectHost(host, secret, { saveSecret, acceptedFingerprint });
      await retryDeviceConnection(host.id);
      refreshSessions();
      router.dismissTo({ pathname: '/hosts/[id]', params: { id: host.id } });
    } catch (error) {
      if (error instanceof RemoteOperationError && error.remoteError.type === 'hostKeyUnknown') {
        const fingerprint = error.remoteError.fingerprint;
        Alert.alert(
          'Trust this host?',
          `${host.hostname}\n${fingerprint}`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Trust and Save',
              onPress: () => {
                void run(fingerprint);
              },
            },
          ],
        );
      } else if (error instanceof RemoteOperationError && error.remoteError.type === 'hostKeyMismatch') {
        Alert.alert(
          'Host key changed',
          `The fingerprint does not match the stored key.\n${error.remoteError.fingerprint ?? ''}\nDo not ignore this unless you rotated keys on purpose.`,
        );
      } else {
        Alert.alert('Could not connect', toUserMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }

  if (!host) {
    return (
      <Screen>
        <ThemedText themeColor="textSecondary">Loading…</ThemedText>
      </Screen>
    );
  }

  const saved = host.credentialId ? remoteClient.hasSecret(host.credentialId) : false;

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Connect' }} />
      <View style={styles.form}>
        <GlassSurface strength="strong" style={styles.server}>
          <View style={[styles.iconFrame, { backgroundColor: theme.background }]}>
            <AppIcon
              name={{ ios: 'server.rack', android: 'dns', web: 'dns' }}
              size={24}
              tintColor={theme.text}
              fallback="□"
            />
          </View>
          <View style={styles.serverCopy}>
            <ThemedText type="section">{host.name}</ThemedText>
            <ThemedText type="caption" themeColor="textSecondary">
              {host.username}@{host.hostname}:{host.port}
            </ThemedText>
          </View>
        </GlassSurface>
        <View style={styles.section}>
          <ThemedText type="section">Authentication</ThemedText>
          <TextField
            label={host.authType === 'privateKey' ? 'Private key' : 'Password'}
            value={secret}
            onChangeText={setSecret}
            placeholder={saved ? 'Use saved credential' : undefined}
            autoComplete="password"
            secureTextEntry={host.authType === 'password'}
          />
          <GlassSurface style={styles.row}>
            <View style={styles.rowCopy}>
              <ThemedText type="small">Remember credential</ThemedText>
              <ThemedText type="caption" themeColor="textMuted">
                Android Keystore
              </ThemedText>
            </View>
            <Switch
              value={saveSecret}
              onValueChange={setSaveSecret}
              trackColor={{ true: theme.accent }}
            />
          </GlassSurface>
        </View>
        <AppButton label={busy ? 'Connecting…' : 'Connect'} onPress={() => void run()} disabled={busy} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: {
    gap: Spacing.three,
  },
  server: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    padding: Spacing.two,
  },
  iconFrame: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.control,
  },
  serverCopy: {
    flex: 1,
    gap: 2,
  },
  section: {
    gap: Spacing.two,
  },
  row: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
  },
  rowCopy: {
    flex: 1,
    gap: 2,
  },
});
