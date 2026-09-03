import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { AppIcon } from '@/components/ui/app-icon';
import { MarqueeText } from '@/components/ui/marquee-text';
import { Fonts, Radius, Spacing } from '@/constants/theme';
import {
  providerLabel,
  statusLabel,
  type AgentWorkspace,
  type RemoteAgent,
} from '@/domain/herdr';
import { AgentProviderIcon } from '@/features/agents/agent-provider-icon';
import { useTheme } from '@/hooks/use-theme';

export type AgentWorkspaceSection = {
  space: AgentWorkspace;
  agents: RemoteAgent[];
};

export function AgentWorkspaceList({
  sections,
}: Readonly<{ sections: AgentWorkspaceSection[] }>) {
  return (
    <>
      {sections.map((section) => (
        <WorkspaceGroup
          key={section.space.id}
          space={section.space}
          agents={section.agents}
        />
      ))}
    </>
  );
}

export function compareAgents(left: RemoteAgent, right: RemoteAgent) {
  const priority: Record<RemoteAgent['status'], number> = {
    blocked: 0,
    done: 1,
    working: 2,
    idle: 3,
    unknown: 4,
  };
  return priority[left.status] - priority[right.status] || left.title.localeCompare(right.title);
}

function WorkspaceGroup({
  space,
  agents,
}: Readonly<AgentWorkspaceSection>) {
  const theme = useTheme();
  return (
    <View style={styles.workspace}>
      <View style={styles.workspaceHeader}>
        <View style={styles.workspaceTitle}>
          <ThemedText type="label" themeColor="textMuted" style={styles.sectionTitle}>
            {space.name.toUpperCase()}
          </ThemedText>
          {space.cwd ? (
            <ThemedText type="caption" themeColor="textMuted" numberOfLines={1}>
              {space.cwd}
            </ThemedText>
          ) : null}
        </View>
        <ThemedText type="caption" themeColor="textMuted">
          {agents.length}
        </ThemedText>
      </View>
      <View
        style={[
          styles.workspaceCard,
          {
            backgroundColor: theme.glassStrong,
            borderColor: theme.glassBorder,
            shadowColor: theme.glassShadow,
          },
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

function AgentRow({ agent }: Readonly<{ agent: RemoteAgent }>) {
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
        <AgentProviderIcon provider={agent.provider} tintColor={theme.accent} />
      </View>
      <View style={styles.agentCopy}>
        <View style={styles.agentTitle}>
          <MarqueeText
            type="caption"
            style={styles.sessionTitle}
            containerStyle={styles.providerName}>
            {agent.title}
          </MarqueeText>
          <StatusBadge status={agent.status} />
        </View>
        <ThemedText type="caption" themeColor="textSecondary" numberOfLines={1}>
          {agent.title === providerLabel(agent.provider)
            ? agent.cwd ?? agent.workspaceName
            : `${providerLabel(agent.provider)}${agent.cwd ? ` · ${agent.cwd}` : ''}`}
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

function StatusBadge({ status }: Readonly<{ status: RemoteAgent['status'] }>) {
  const theme = useTheme();
  const color =
    status === 'working'
      ? theme.accent
      : status === 'blocked'
        ? theme.warning
        : status === 'done'
          ? theme.success
          : theme.textMuted;
  return (
    <View
      accessibilityLabel={statusLabel(status)}
      style={[
        styles.statusDot,
        {
          backgroundColor: status === 'idle' ? 'transparent' : color,
          borderColor: color,
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  workspace: {
    gap: Spacing.one,
  },
  workspaceHeader: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.two,
    paddingHorizontal: Spacing.half,
  },
  workspaceTitle: {
    flex: 1,
    gap: 2,
  },
  sectionTitle: {
    letterSpacing: 0.7,
  },
  workspaceCard: {
    borderWidth: 1,
    borderRadius: Radius.glass,
    overflow: 'hidden',
    elevation: 2,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 1,
    shadowRadius: 18,
  },
  agent: {
    minHeight: 68,
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
    minWidth: 0,
  },
  sessionTitle: {
    fontFamily: Fonts.semibold,
    fontWeight: 600,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderWidth: 1.5,
    borderRadius: 3.5,
  },
});
