import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { AppButton } from '@/components/ui/app-button';
import { GlassSurface } from '@/components/ui/glass-surface';
import { Screen } from '@/components/ui/screen';
import { ThemedText } from '@/components/themed-text';
import { Fonts, Radius, Spacing } from '@/constants/theme';
import type { HostProfile } from '@/domain/hosts';
import { refreshSessions, useHostSession } from '@/features/connection/use-host-session';
import { useTheme } from '@/hooks/use-theme';
import { hostRepository } from '@/services/host-repository';
import { remoteClient } from '@/services/native-remote-client';
import { toUserMessage } from '@/utils/user-error';

export default function EditHostScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const [host, setHost] = useState<HostProfile | null | undefined>(undefined);
  const session = useHostSession(id ?? '');

  useEffect(() => {
    let active = true;
    if (!id) {
      return;
    }
    void hostRepository.get(id).then((nextHost) => {
      if (active) {
        setHost(nextHost);
      }
    });
    return () => {
      active = false;
    };
  }, [id]);

  function confirmDelete(target: HostProfile) {
    Alert.alert(
      'Delete server',
      `Remove ${target.name}? This only deletes the saved profile on this device.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                await hostRepository.remove(target.id);
                router.back();
              } catch (error) {
                Alert.alert('Could not delete server', toUserMessage(error));
              }
            })();
          },
        },
      ],
    );
  }

  if (host === undefined) {
    return (
      <Screen>
        <ThemedText themeColor="textSecondary">Loading…</ThemedText>
      </Screen>
    );
  }

  if (host === null) {
    return (
      <Screen>
        <View style={styles.missing}>
          <ThemedText type="heading">Server not found</ThemedText>
          <ThemedText themeColor="textSecondary">
            It may have already been deleted.
          </ThemedText>
          <AppButton label="Back" variant="secondary" onPress={() => router.back()} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: 'Server' }} />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}>
        <GlassSurface strength="strong" style={styles.overview}>
          <View style={styles.serverSummary}>
            <View style={[styles.serverIcon, { backgroundColor: theme.accentSoft }]}>
              <AppIcon
                name={{ ios: 'server.rack', android: 'dns', web: 'dns' }}
                size={26}
                tintColor={theme.text}
                fallback="□"
              />
            </View>
            <View style={styles.serverCopy}>
              <ThemedText type="heading">{host.name}</ThemedText>
              <ThemedText
                type="caption"
                themeColor="textSecondary"
                style={styles.endpoint}>
                {host.username}@{host.hostname}:{host.port}
              </ThemedText>
            </View>
            <View
              style={[
                styles.status,
                {
                  backgroundColor: session ? theme.successSoft : theme.glass,
                  borderColor: session ? theme.success : theme.border,
                },
              ]}>
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: session ? theme.success : theme.textMuted },
                ]}
              />
              <ThemedText
                type="caption"
                style={{ color: session ? theme.success : theme.textMuted }}>
                {session ? 'Connected' : 'Offline'}
              </ThemedText>
            </View>
          </View>
          <View style={styles.primaryAction}>
            <AppButton
              label={session ? 'Open agents' : 'Connect'}
              onPress={() => {
                if (session) {
                  router.push('/');
                  return;
                }
                router.push({ pathname: '/connect/[id]', params: { id: host.id } });
              }}
            />
          </View>
        </GlassSurface>

        <View style={styles.section}>
          <ThemedText type="section">Server tools</ThemedText>
          <View style={styles.toolGrid}>
            <ActionTile
              label="Files"
              icon={{ ios: 'folder', android: 'folder', web: 'folder' }}
              disabled={!session}
              onPress={() =>
                router.push({ pathname: '/files/[id]', params: { id: host.id } })
              }
            />
            <ActionTile
              label="Monitor"
              icon={{ ios: 'waveform.path.ecg', android: 'monitor_heart', web: 'monitor_heart' }}
              disabled={!session}
              onPress={() =>
                router.push({ pathname: '/monitor/[id]', params: { id: host.id } })
              }
            />
            <ActionTile
              label="Docker"
              icon={{ ios: 'shippingbox', android: 'deployed_code', web: 'deployed_code' }}
              disabled={!session}
              onPress={() =>
                router.push({ pathname: '/docker/[id]', params: { id: host.id } })
              }
            />
            <ActionTile
              label="Tunnels"
              icon={{ ios: 'arrow.left.arrow.right', android: 'lan', web: 'lan' }}
              disabled={!session}
              onPress={() =>
                router.push({ pathname: '/tunnels/[id]', params: { id: host.id } })
              }
            />
          </View>
        </View>

        <View style={styles.section}>
          <ThemedText type="section">Connection</ThemedText>
          <GlassSurface style={styles.detailsCard}>
            <InfoRow label="Host" value={host.hostname} />
            <Divider />
            <InfoRow label="Port" value={String(host.port)} />
            <Divider />
            <InfoRow label="Username" value={host.username} />
            <Divider />
            <InfoRow
              label="Authentication"
              value={host.authType === 'privateKey' ? 'Private key' : 'Password'}
            />
          </GlassSurface>
        </View>

        <View style={styles.manage}>
          {session ? (
            <AppButton
              label="Disconnect"
              variant="secondary"
              onPress={() => {
                void remoteClient.disconnectHost(host.id).then(refreshSessions);
              }}
            />
          ) : null}
          <AppButton
            label="Edit server"
            variant="secondary"
            onPress={() =>
              router.push({ pathname: '/hosts/[id]/edit', params: { id: host.id } })
            }
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Delete server"
            accessibilityHint="Removes this saved server after confirmation"
            onPress={() => confirmDelete(host)}
            style={({ pressed }) => [styles.deleteAction, pressed && styles.pressed]}>
            <ThemedText type="smallBold">Delete server</ThemedText>
          </Pressable>
        </View>
      </ScrollView>
    </Screen>
  );
}

type ActionTileProps = {
  label: string;
  icon: {
    ios: 'folder' | 'waveform.path.ecg' | 'shippingbox' | 'arrow.left.arrow.right';
    android: 'folder' | 'monitor_heart' | 'deployed_code' | 'lan';
    web: 'folder' | 'monitor_heart' | 'deployed_code' | 'lan';
  };
  disabled?: boolean;
  onPress: () => void;
};

function ActionTile({ label, icon, disabled, onPress }: ActionTileProps) {
  const theme = useTheme();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.tool,
        {
          opacity: disabled ? 0.42 : pressed ? 0.72 : 1,
          transform: [{ scale: pressed ? 0.96 : 1 }],
        },
      ]}>
      <View
        style={[
          styles.toolIcon,
          { backgroundColor: theme.backgroundElement, borderColor: theme.border },
        ]}>
        <AppIcon name={icon} size={23} tintColor={theme.text} fallback="□" />
      </View>
      <ThemedText type="caption" numberOfLines={1}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <ThemedText type="small" themeColor="textMuted">
        {label}
      </ThemedText>
      <ThemedText type="smallBold" numberOfLines={1} style={styles.infoValue}>
        {value}
      </ThemedText>
    </View>
  );
}

function Divider() {
  const theme = useTheme();
  return <View style={[styles.divider, { backgroundColor: theme.border }]} />;
}

const styles = StyleSheet.create({
  content: {
    gap: Spacing.four,
    paddingBottom: Spacing.four,
  },
  overview: {
    gap: Spacing.two,
    padding: Spacing.two,
  },
  serverSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  serverCopy: {
    flex: 1,
    gap: 2,
  },
  serverIcon: {
    width: 52,
    height: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.control,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.half,
    borderWidth: 1,
    borderRadius: Radius.tag,
    paddingHorizontal: Spacing.one,
    paddingVertical: 3,
  },
  statusDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  endpoint: {
    fontFamily: Fonts.mono,
  },
  primaryAction: {
    alignSelf: 'stretch',
  },
  section: {
    gap: Spacing.two,
  },
  toolGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: Spacing.one,
  },
  tool: {
    width: '23%',
    minHeight: 86,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
  },
  toolIcon: {
    width: 58,
    height: 58,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: Radius.pill,
  },
  detailsCard: {
    overflow: 'hidden',
  },
  infoRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
  },
  infoValue: {
    flex: 1,
    textAlign: 'right',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: Spacing.two,
  },
  manage: {
    gap: Spacing.one,
  },
  deleteAction: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
  missing: {
    flex: 1,
    justifyContent: 'center',
    gap: Spacing.three,
  },
});
