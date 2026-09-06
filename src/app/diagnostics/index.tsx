import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import type { HostProfile } from '@/domain/hosts';
import { useHerdr } from '@/features/agents/use-herdr';
import { sessionDiagnosticsCommand } from '@/features/agents/session-diagnostics';
import { useTheme } from '@/hooks/use-theme';
import { herdrRepository } from '@/services/herdr-repository';
import { hostRepository } from '@/services/host-repository';
import { remoteClient } from '@/services/native-remote-client';
import { toUserMessage } from '@/utils/user-error';

export default function DiagnosticsScreen() {
  const theme = useTheme();
  const { agentId } = useLocalSearchParams<{ agentId?: string }>();
  const state = useHerdr();
  const [hosts, setHosts] = useState<HostProfile[]>([]);

  useEffect(() => {
    let active = true;
    void hostRepository
      .list()
      .then((list) => {
        if (active) setHosts(list);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const deviceId = agentId ? herdrRepository.deviceIdForAgent(agentId) : state.selectedDeviceId;
  const device = deviceId ? state.devices[deviceId] : undefined;
  const diagnostics = device ? {
    connection: device.connection,
    bridgeVersion: device.hello?.bridgeVersion,
    protocol: device.hello?.protocol,
    herdrVersion: device.runtime.herdrVersion,
    herdrSession: device.runtime.herdrSession,
    agents: device.runtime.agents.length,
    lastRuntimeEvent: device.runtime.lastRuntimeEvent,
    lastSemanticEvent: null,
    lastError: device.lastError,
  } : herdrRepository.diagnostics();

  const nativeVersion = Application.nativeApplicationVersion;
  const nativeBuild = Application.nativeBuildVersion;
  const configVersion = Constants.expoConfig?.version;
  const configBuild =
    Constants.expoConfig?.android?.versionCode ??
    Constants.expoConfig?.ios?.buildNumber;
  const versionDisplay = `${nativeVersion || configVersion || '0.1.0'}${nativeBuild || configBuild ? ` (${nativeBuild || configBuild})` : ''}`;

  let sshStatusSummary = 'Disconnected';
  if (deviceId) {
    const session = remoteClient.getSession(deviceId);
    sshStatusSummary =
      session?.status === 'connected'
        ? 'Connected'
        : session?.status === 'connecting'
          ? 'Connecting…'
          : 'Disconnected';
  } else if (hosts.length > 0) {
    const connectedCount = hosts.filter((h) => remoteClient.getSession(h.id)?.status === 'connected').length;
    const connectingCount = hosts.filter((h) => remoteClient.getSession(h.id)?.status === 'connecting').length;
    if (connectedCount === hosts.length) {
      sshStatusSummary = `All connected (${hosts.length}/${hosts.length})`;
    } else if (connectedCount === 0) {
      sshStatusSummary =
        connectingCount > 0
          ? `Connecting… (${connectingCount}/${hosts.length})`
          : `All disconnected (0/${hosts.length})`;
    } else {
      sshStatusSummary = `Degraded (${connectedCount}/${hosts.length} connected)`;
    }
  } else {
    const active = remoteClient.listSessions().filter((s) => s.status === 'connected');
    sshStatusSummary = active.length > 0 ? `${active.length} active session${active.length > 1 ? 's' : ''}` : 'Disconnected';
  }

  const targetLabel = deviceId
    ? (hosts.find((h) => h.id === deviceId)?.name ?? deviceId)
    : 'All devices';

  const rows = [
    ['App version', versionDisplay],
    ['Target device', targetLabel],
    ['SSH status', sshStatusSummary],
    ['Bridge', diagnostics.connection],
    ['Bridge version', diagnostics.bridgeVersion ?? '—'],
    ['Protocol', diagnostics.protocol?.toString() ?? '—'],
    ['Herdr version', diagnostics.herdrVersion ?? '—'],
    ['Herdr session', diagnostics.herdrSession ?? '—'],
    ['Agents', diagnostics.agents.toString()],
    ['Last runtime event', formatTimestamp(diagnostics.lastRuntimeEvent)],
    ['Last semantic event', diagnostics.lastSemanticEvent ?? '—'],
    ['Last error', diagnostics.lastError ?? '—'],
  ];

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.content}>
        <View
          style={[
            styles.card,
            { backgroundColor: theme.backgroundElement, borderColor: theme.border },
          ]}>
          {rows.map(([label, value], index) => (
            <View key={label}>
              <View style={styles.row}>
                <ThemedText type="small" themeColor="textMuted">
                  {label}
                </ThemedText>
                <ThemedText type="smallBold" style={styles.value} selectable>
                  {value}
                </ThemedText>
              </View>
              {index < rows.length - 1 ? (
                <View style={[styles.divider, { backgroundColor: theme.border }]} />
              ) : null}
            </View>
          ))}
        </View>

        {hosts.length > 0 && !agentId ? (
          <View style={styles.section}>
            <ThemedText type="label" themeColor="textMuted" style={styles.sectionHeader}>
              SERVER CONNECTIONS ({hosts.length})
            </ThemedText>
            <View
              style={[
                styles.card,
                { backgroundColor: theme.backgroundElement, borderColor: theme.border },
              ]}>
              {hosts.map((host, index) => {
                const session = remoteClient.getSession(host.id);
                const dev = state.devices[host.id];
                const isConnected = session?.status === 'connected';
                const isConnecting = session?.status === 'connecting';
                const statusColor = isConnected
                  ? theme.success
                  : isConnecting
                    ? theme.warning
                    : theme.textMuted;
                const statusText = isConnected
                  ? 'Connected'
                  : isConnecting
                    ? 'Connecting…'
                    : 'Disconnected';
                const bridgeText = dev?.connection ?? 'disconnected';
                const error = dev?.lastError;

                return (
                  <View key={host.id}>
                    <View style={styles.serverRow}>
                      <View style={styles.serverDetails}>
                        <ThemedText type="smallBold" numberOfLines={1}>
                          {host.name}
                        </ThemedText>
                        <ThemedText type="caption" themeColor="textMuted" numberOfLines={1}>
                          {host.username}@{host.hostname}:{host.port} • Bridge: {bridgeText}
                        </ThemedText>
                        {error ? (
                          <ThemedText type="caption" themeColor="danger" numberOfLines={2}>
                            Error: {error}
                          </ThemedText>
                        ) : null}
                      </View>
                      <ThemedText type="smallBold" style={{ color: statusColor }}>
                        {statusText}
                      </ThemedText>
                    </View>
                    {index < hosts.length - 1 ? (
                      <View style={[styles.divider, { backgroundColor: theme.border }]} />
                    ) : null}
                  </View>
                );
              })}
            </View>
          </View>
        ) : null}

        {agentId ? <SessionDiagnostics agentId={agentId} /> : null}
      </ScrollView>
    </Screen>
  );
}

function SessionDiagnostics({ agentId }: { agentId: string }) {
  const { devices } = useHerdr();
  const deviceId = herdrRepository.deviceIdForAgent(agentId);
  const device = deviceId ? devices[deviceId] : undefined;
  const agent = device?.runtime.agents.find((value) => value.id === agentId);
  const ssh = deviceId ? remoteClient.getSession(deviceId) : null;
  const [result, setResult] = useState<{ request: string; text: string } | null>(null);
  const paneId = agent?.paneId;
  const socketPath = device?.runtime.socketPath ?? '~/.config/herdr/herdr.sock';
  const sessionId = ssh?.status === 'connected' ? ssh.sessionId : undefined;
  const request = JSON.stringify([paneId, sessionId, socketPath]);
  const text = !paneId || !sessionId
    ? 'Connect this agent’s device before reading session diagnostics.'
    : result?.request === request ? result.text : 'Loading session diagnostics...';

  useEffect(() => {
    let cancelled = false;
    if (!paneId || !sessionId) return;
    void remoteClient.exec(sessionId, sessionDiagnosticsCommand(paneId, socketPath)).then((response) => {
      if (cancelled) return;
      setResult({ request, text: response.exitCode === 0 ? response.stdout : response.stderr || 'Session diagnostics failed.' });
    }).catch((error) => {
      if (!cancelled) setResult({ request, text: toUserMessage(error) });
    });
    return () => { cancelled = true; };
  }, [paneId, sessionId, socketPath, request]);

  return (
    <View style={styles.session}>
      <ThemedText type="smallBold">Session diagnostics</ThemedText>
      <ThemedText type="small" selectable>{text}</ThemedText>
    </View>
  );
}

function formatTimestamp(timestamp?: number): string {
  return timestamp ? new Date(timestamp * 1000).toLocaleString() : '—';
}

const styles = StyleSheet.create({
  session: { padding: Spacing.two, gap: Spacing.two },
  content: {
    paddingBottom: Spacing.four,
  },
  section: {
    marginTop: Spacing.three,
    gap: Spacing.one,
  },
  sectionHeader: {
    letterSpacing: 0.7,
    paddingHorizontal: Spacing.half,
  },
  serverRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  serverDetails: {
    flex: 1,
    gap: 2,
  },
  card: {
    borderWidth: 1,
    borderRadius: Radius.control,
    overflow: 'hidden',
  },
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
  },
  value: {
    flex: 1,
    textAlign: 'right',
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: Spacing.two,
  },
});
