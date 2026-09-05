import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AppIcon, type AppIconName } from '@/components/ui/app-icon';
import { AppButton } from '@/components/ui/app-button';
import { GlassSurface } from '@/components/ui/glass-surface';
import { Screen } from '@/components/ui/screen';
import { ThemedText } from '@/components/themed-text';
import { Fonts, Radius, Spacing } from '@/constants/theme';
import { RemoteOperationError } from '@/domain/errors';
import type { HostProfile } from '@/domain/hosts';
import { ensureHostConnected } from '@/features/connection/saved-host-connector';
import { refreshSessions, useHostSession } from '@/features/connection/use-host-session';
import { deleteHost } from '@/features/hosts/host-lifecycle';
import { useTheme } from '@/hooks/use-theme';
import { hostRepository } from '@/services/host-repository';
import { remoteClient } from '@/services/native-remote-client';
import { toUserMessage } from '@/utils/user-error';
import { disconnectDeviceRuntime, retryDeviceConnection } from '@/features/agents/connect-runtime';
import { ConnectionDetails } from '@/features/connection/connection-status';

export default function HostDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const theme = useTheme();
  const [host, setHost] = useState<HostProfile | null | undefined>(undefined);
  const [connecting, setConnecting] = useState(false);
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
                await deleteHost(target);
                refreshSessions();
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

  const hasSavedCredential =
    !!host.credentialId && remoteClient.hasSecret(host.credentialId);

  async function connectSavedCredential(
    target: HostProfile,
    acceptedFingerprint?: string,
  ) {
    setConnecting(true);
    try {
      await ensureHostConnected(target, acceptedFingerprint);
      await retryDeviceConnection(target.id);
    } catch (error) {
      if (
        error instanceof RemoteOperationError &&
        error.remoteError.type === 'hostKeyUnknown'
      ) {
        const fingerprint = error.remoteError.fingerprint;
        Alert.alert(
          'Trust this host?',
          `${target.hostname}\n${fingerprint}`,
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Trust and Save',
              onPress: () => {
                void connectSavedCredential(target, fingerprint);
              },
            },
          ],
        );
      } else {
        Alert.alert('Could not connect', toUserMessage(error));
      }
    } finally {
      setConnecting(false);
    }
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
                size={22}
                tintColor={theme.accent}
                fallback="□"
              />
            </View>
            <View style={styles.serverCopy}>
              <ThemedText type="heading" numberOfLines={1} style={styles.serverName}>
                {host.name}
              </ThemedText>
              <View style={styles.serverMeta}>
                <ThemedText
                  type="caption"
                  themeColor="textSecondary"
                  numberOfLines={1}
                  style={styles.endpoint}>
                  {host.username}@{host.hostname}:{host.port}
                </ThemedText>
                <View
                  accessible
                  accessibilityLabel={session ? 'Connected' : 'Offline'}
                  style={styles.status}>
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
            </View>
          </View>
          <View style={styles.primaryAction}>
            <AppButton
              label={session ? 'Open agents' : connecting ? 'Connecting…' : 'Connect'}
              disabled={connecting}
              onPress={() => {
                if (session) {
                  router.push('/');
                  return;
                }
                if (hasSavedCredential) {
                  void connectSavedCredential(host);
                  return;
                }
                router.push({ pathname: '/connect/[id]', params: { id: host.id } });
              }}
            />
          </View>
        </GlassSurface>

        <ConnectionDetails deviceId={host.id} />

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

        <View style={styles.section}>
          <ThemedText type="section">Manage</ThemedText>
          <View style={styles.manageActions}>
            {session ? (
              <View style={styles.manageButton}>
                <AppButton
                  label="Disconnect"
                  variant="secondary"
                  onPress={() => {
                    void disconnectDeviceRuntime(host.id)
                      .then(refreshSessions)
                      .catch((error) => {
                        Alert.alert('Could not disconnect', toUserMessage(error));
                      });
                  }}
                />
              </View>
            ) : null}
            <View style={styles.manageButton}>
              <AppButton
                label="Edit server"
                variant="secondary"
                onPress={() =>
                  router.push({ pathname: '/hosts/[id]/edit', params: { id: host.id } })
                }
              />
            </View>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Delete server"
            accessibilityHint="Removes this saved server after confirmation"
            onPress={() => confirmDelete(host)}
            style={({ pressed }) => [styles.deleteAction, pressed && styles.pressed]}>
            <ThemedText type="smallBold" themeColor="danger">
              Delete server
            </ThemedText>
          </Pressable>
        </View>
      </ScrollView>
    </Screen>
  );
}

type ActionTileProps = {
  label: string;
  icon: AppIconName;
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
          { backgroundColor: theme.accentSoft, borderColor: theme.glassBorder },
        ]}>
        <AppIcon name={icon} size={21} tintColor={theme.accent} fallback="□" />
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
    gap: Spacing.three,
    paddingBottom: Spacing.four,
  },
  overview: {
    gap: Spacing.one + Spacing.half,
    padding: Spacing.one + Spacing.half,
  },
  serverSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  serverCopy: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  serverName: {
    fontSize: 20,
    lineHeight: 26,
    letterSpacing: -0.2,
  },
  serverMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  serverIcon: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
  },
  status: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.half,
  },
  statusDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  endpoint: {
    flex: 1,
    fontFamily: Fonts.mono,
  },
  primaryAction: {
    alignSelf: 'stretch',
  },
  section: {
    gap: Spacing.one + Spacing.half,
  },
  toolGrid: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: Spacing.one,
  },
  tool: {
    flex: 1,
    minHeight: 72,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
  },
  toolIcon: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: Radius.pill,
  },
  detailsCard: {
    overflow: 'hidden',
  },
  infoRow: {
    minHeight: 48,
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
  manageActions: {
    flexDirection: 'row',
    gap: Spacing.one,
  },
  manageButton: {
    flex: 1,
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
