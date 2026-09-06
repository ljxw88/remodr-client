import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useHerdr } from '@/features/agents/use-herdr';
import { sessionDiagnosticsCommand } from '@/features/agents/session-diagnostics';
import { useTheme } from '@/hooks/use-theme';
import { herdrRepository } from '@/services/herdr-repository';
import { remoteClient } from '@/services/native-remote-client';
import { toUserMessage } from '@/utils/user-error';

export default function DiagnosticsScreen() {
  const theme = useTheme();
  const { agentId } = useLocalSearchParams<{ agentId?: string }>();
  const state = useHerdr();
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
  const sshSessions = remoteClient.listSessions();
  const rows = [
    ['Device', deviceId ?? 'None'],
    ['SSH', (deviceId
      ? remoteClient.getSession(deviceId)?.status === 'connected'
      : sshSessions.length > 0) ? 'Connected' : 'Disconnected'],
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
