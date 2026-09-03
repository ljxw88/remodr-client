import { Stack } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useHerdr } from '@/features/agents/use-herdr';
import { useTheme } from '@/hooks/use-theme';
import { herdrRepository } from '@/services/herdr-repository';
import { remoteClient } from '@/services/native-remote-client';

export default function DiagnosticsScreen() {
  const theme = useTheme();
  useHerdr();
  const diagnostics = herdrRepository.diagnostics();
  const sshSessions = remoteClient.listSessions();
  const rows = [
    ['SSH', sshSessions.length > 0 ? 'Connected' : 'Disconnected'],
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
      <Stack.Screen
        options={{
          title: 'Diagnostics',
          headerShown: true,
          headerStyle: { backgroundColor: 'transparent' },
          headerTintColor: theme.text,
          headerShadowVisible: false,
        }}
      />
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
      </ScrollView>
    </Screen>
  );
}

function formatTimestamp(timestamp?: number): string {
  return timestamp ? new Date(timestamp * 1000).toLocaleString() : '—';
}

const styles = StyleSheet.create({
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
