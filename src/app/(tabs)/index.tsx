import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { EmptyState } from '@/components/ui/empty-state';
import { Screen } from '@/components/ui/screen';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import {
  providerLabel,
  statusLabel,
  type AgentProvider,
  type RemoteAgent,
} from '@/domain/herdr';
import { connectAgentRuntime } from '@/features/agents/connect-runtime';
import { useHerdr } from '@/features/agents/use-herdr';
import { useTheme } from '@/hooks/use-theme';

export default function AgentsScreen() {
  const theme = useTheme();
  const state = useHerdr();
  const sections = useMemo(() => {
    const grouped = new Map<string, RemoteAgent[]>();
    for (const agent of state.runtime.agents) {
      const agents = grouped.get(agent.workspaceName) ?? [];
      agents.push(agent);
      grouped.set(agent.workspaceName, agents);
    }
    return [...grouped.entries()].map(([title, data]) => ({ title, data }));
  }, [state.runtime.agents]);

  useFocusEffect(
    useCallback(() => {
      if (state.connection === 'connected' || state.connection === 'starting_bridge') {
        return;
      }
      void connectAgentRuntime().catch((error) => {
        console.warn('[HERDR_RUNTIME] Could not connect', error);
      });
    }, [state.connection]),
  );

  const busy = ['connecting', 'starting_bridge', 'synchronizing'].includes(state.connection);
  const connected = state.connection === 'connected';
  const connectionColor = connected ? theme.success : busy ? theme.accent : theme.warning;
  const connectionBackground = connected
    ? theme.successSoft
    : busy
      ? theme.accentSoft
      : theme.warningSoft;

  return (
    <Screen includeTopSafeArea>
      <View style={styles.header}>
        <View
          style={[
            styles.connection,
            { backgroundColor: connectionBackground, borderColor: connectionColor },
          ]}>
          <View
            style={[
              styles.connectionDot,
              {
                backgroundColor: connected ? connectionColor : 'transparent',
                borderColor: connectionColor,
              },
            ]}
          />
          <ThemedText type="caption" style={{ color: connectionColor }}>
            {connected ? 'Connected' : busy ? 'Connecting' : 'Offline'}
          </ThemedText>
        </View>
      </View>

      {state.connection === 'reconnecting' || state.connection === 'error' ? (
        <View
          style={[
            styles.banner,
            {
              backgroundColor: theme.glassStrong,
              borderColor: theme.glassBorder,
              shadowColor: theme.glassShadow,
            },
          ]}>
          <ThemedText type="small">
            {state.connection === 'reconnecting' ? 'Reconnecting to Herdr' : 'Herdr unavailable'}
          </ThemedText>
          <Pressable onPress={() => void connectAgentRuntime()}>
            <ThemedText type="smallBold" style={{ color: theme.accent }}>
              Retry
            </ThemedText>
          </Pressable>
        </View>
      ) : null}

      {busy && state.runtime.agents.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
          <ThemedText type="small" themeColor="textMuted">
            Loading agents
          </ThemedText>
        </View>
      ) : sections.length === 0 ? (
        <EmptyState
          title="No agents available"
          body="Connect a saved server, then Herdr agents will appear here."
          actionLabel="Open servers"
          onAction={() => router.push('/servers')}
        />
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.list}>
          {sections.map((section) => (
            <WorkspaceGroup key={section.title} title={section.title} agents={section.data} />
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}

function WorkspaceGroup({ title, agents }: { title: string; agents: RemoteAgent[] }) {
  const theme = useTheme();
  return (
    <View style={styles.workspace}>
      <ThemedText type="label" themeColor="textMuted" style={styles.sectionTitle}>
        {title.toUpperCase()}
      </ThemedText>
      <View
        style={[
          styles.workspaceCard,
          { backgroundColor: theme.backgroundElement, borderColor: theme.border },
        ]}>
        {agents.map((agent, index) => (
          <View key={agent.id}>
            <AgentRow agent={agent} />
            {index < agents.length - 1 ? (
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
            ) : null}
          </View>
        ))}
      </View>
    </View>
  );
}

function AgentRow({ agent }: { agent: RemoteAgent }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${providerLabel(agent.provider)}, ${statusLabel(agent.status)}`}
      onPress={() => router.push({ pathname: '/agents/[id]', params: { id: agent.id } })}
      style={({ pressed }) => [
        styles.agent,
        {
          backgroundColor: pressed ? theme.backgroundSelected : 'transparent',
          transform: [{ scale: pressed ? 0.99 : 1 }],
        },
      ]}>
      <View style={[styles.providerIcon, { backgroundColor: theme.accentSoft }]}>
        <AppIcon
          name={providerIcon(agent.provider)}
          size={22}
          tintColor={theme.text}
          fallback="A"
        />
      </View>
      <View style={styles.agentCopy}>
        <View style={styles.agentTitle}>
          <ThemedText type="section" numberOfLines={1} style={styles.providerName}>
            {providerLabel(agent.provider)}
          </ThemedText>
          <StatusBadge status={agent.status} />
        </View>
        <ThemedText type="caption" themeColor="textSecondary" numberOfLines={1}>
          {agent.cwd ?? agent.title}
        </ThemedText>
      </View>
      <AppIcon
        name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
        size={18}
        tintColor={theme.textMuted}
        fallback="›"
      />
    </Pressable>
  );
}

function StatusBadge({ status }: { status: RemoteAgent['status'] }) {
  const theme = useTheme();
  const color =
    status === 'working'
      ? theme.accent
      : status === 'blocked'
        ? theme.warning
        : status === 'done'
          ? theme.success
          : theme.textMuted;
  const backgroundColor =
    status === 'working'
      ? theme.accentSoft
      : status === 'blocked'
        ? theme.warningSoft
        : status === 'done'
          ? theme.successSoft
          : theme.glass;
  return (
    <View style={[styles.status, { backgroundColor, borderColor: color }]}>
      <View
        style={[
          styles.statusDot,
          {
            backgroundColor: status === 'idle' ? 'transparent' : color,
            borderColor: color,
          },
        ]}
      />
      <ThemedText type="caption" style={{ color }}>
        {statusLabel(status)}
      </ThemedText>
    </View>
  );
}

function providerIcon(provider: AgentProvider) {
  switch (provider) {
    case 'copilot':
      return {
        ios: 'chevron.left.forwardslash.chevron.right' as const,
        android: 'code' as const,
        web: 'code' as const,
      };
    case 'claude':
      return {
        ios: 'text.bubble' as const,
        android: 'chat' as const,
        web: 'chat' as const,
      };
    case 'codex':
      return {
        ios: 'terminal' as const,
        android: 'terminal' as const,
        web: 'terminal' as const,
      };
    default:
      return {
        ios: 'curlybraces' as const,
        android: 'data_object' as const,
        web: 'data_object' as const,
      };
  }
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: Spacing.two,
    marginBottom: Spacing.one,
  },
  connection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.half,
    paddingHorizontal: Spacing.one,
    paddingVertical: 4,
    borderWidth: 1,
    borderRadius: Radius.pill,
  },
  connectionDot: {
    width: 6,
    height: 6,
    borderWidth: 1,
    borderRadius: 3,
  },
  banner: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
    marginBottom: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.glass,
    elevation: 3,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 1,
    shadowRadius: 18,
  },
  list: {
    gap: Spacing.three,
    paddingBottom: Spacing.four,
  },
  workspace: {
    gap: Spacing.one,
  },
  sectionTitle: {
    letterSpacing: 0.7,
    paddingHorizontal: Spacing.half,
  },
  workspaceCard: {
    borderWidth: 1,
    borderRadius: Radius.glass,
    overflow: 'hidden',
  },
  agent: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
  },
  providerIcon: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 76,
  },
  agentCopy: {
    flex: 1,
    gap: 4,
  },
  agentTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  providerName: {
    flex: 1,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: Spacing.one,
    paddingVertical: 3,
    borderWidth: 1,
    borderRadius: Radius.pill,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderWidth: 1,
    borderRadius: 3,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
  },
});
