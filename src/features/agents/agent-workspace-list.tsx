import { router } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { AppIcon } from '@/components/ui/app-icon';
import { FinishDot } from '@/components/ui/finish-dot';
import { GlassSurface } from '@/components/ui/glass-surface';
import { MarqueeText } from '@/components/ui/marquee-text';
import { SkeletonBlock, SkeletonGroup, SkeletonLine } from '@/components/ui/skeleton';
import { Fonts, Spacing } from '@/constants/theme';
import { unreadCompletionCount } from '@/domain/agent-completion';
import {
  providerLabel,
  statusLabel,
  type RemoteAgent,
} from '@/domain/herdr';
import { AgentProviderIcon } from '@/features/agents/agent-provider-icon';
import { useTheme } from '@/hooks/use-theme';
import type { AgentWorkspaceSection } from './agent-ordering';

export { compareAgents, type AgentWorkspaceSection } from './agent-ordering';

export function AgentWorkspaceList({
  sections, active = true,
}: Readonly<{ sections: AgentWorkspaceSection[]; active?: boolean }>) {
  return (
    <>
      {sections.map((section) => (
        <WorkspaceGroup
          key={section.space.id}
          space={section.space}
          agents={section.agents}
          active={active}
        />
      ))}
    </>
  );
}

export function AgentWorkspaceSkeleton() {
  const theme = useTheme();
  return (
    <SkeletonGroup label="Loading agents" style={styles.workspace}>
      <View style={styles.workspaceHeader}>
        <View style={styles.workspaceTitle}>
          <SkeletonLine width="42%" />
          <SkeletonLine width="68%" />
        </View>
      </View>
      <GlassSurface strength="strong" style={styles.workspaceCard}>
        {[0, 1, 2].map((row) => (
          <View key={row}>
            <View style={styles.agent}>
              <SkeletonBlock width={styles.providerIcon.width} height={styles.providerIcon.height}
                radius={styles.providerIcon.borderRadius} />
              <View style={styles.agentCopy}>
                <View style={styles.agentTitle}>
                  <View style={styles.providerName}><SkeletonLine width={row === 1 ? '60%' : '80%'} /></View>
                  <SkeletonBlock width={7} height={7} radius={3.5} />
                </View>
                <SkeletonLine width="92%" />
              </View>
              <SkeletonBlock width={18} height={12} />
            </View>
            {row < 2 ? <View style={[styles.divider, { backgroundColor: theme.border }]} /> : null}
          </View>
        ))}
      </GlassSurface>
    </SkeletonGroup>
  );
}

function WorkspaceGroup({
  space,
  agents,
  active,
}: Readonly<AgentWorkspaceSection & { active: boolean }>) {
  const theme = useTheme();
  const unread = unreadCompletionCount(agents);
  return (
    <View style={styles.workspace}>
      <View style={styles.workspaceHeader}>
        <View style={styles.workspaceTitle}>
          <View style={styles.workspaceTitleRow}>
            <ThemedText type="label" themeColor="textMuted" style={styles.sectionTitle} numberOfLines={1}>
              {space.name.toUpperCase()}
            </ThemedText>
            {unread > 0 ? (
              <FinishDot
                count={unread}
                label={`${unread} unread finished ${unread === 1 ? 'agent' : 'agents'} in ${space.name}`}
              />
            ) : null}
          </View>
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
      <GlassSurface strength="strong" style={styles.workspaceCard}>
        {agents.map((agent, index) => (
          <View key={agent.id}>
            <AgentRow agent={agent} active={active} />
            {index < agents.length - 1 ? (
              <View style={[styles.divider, { backgroundColor: theme.border }]} />
            ) : null}
          </View>
        ))}
      </GlassSurface>
    </View>
  );
}

function AgentRow({ agent, active }: Readonly<{ agent: RemoteAgent; active: boolean }>) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${providerLabel(agent.provider)}, ${statusLabel(agent.status)}${
        agent.completion?.unread ? ', unread finished work' : ''
      }`}
      onPress={() => router.push({ pathname: '/agents/[id]', params: { id: agent.id } })}
      style={({ pressed }) => [
        styles.agent,
        // No press scale. A row fills its card edge to edge, so shrinking it
        // pulls the highlight in and leaves the card showing down both sides.
        // Scale belongs to controls that stand alone on the canvas.
        { backgroundColor: pressed ? theme.backgroundSelected : 'transparent' },
      ]}>
      <GlassSurface highlight={false} style={[styles.providerIcon, { backgroundColor: theme.accentSoft }]}>
        <AgentProviderIcon provider={agent.provider} tintColor={theme.accent} />
      </GlassSurface>
      <View style={styles.agentCopy}>
        <View style={styles.agentTitle}>
          <MarqueeText
            active={active}
            type="caption"
            style={styles.sessionTitle}
            containerStyle={styles.providerName}>
            {agent.title}
          </MarqueeText>
          {agent.completion?.unread ? (
            <FinishDot label="Unread finished work" />
          ) : null}
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
  workspaceTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.half,
  },
  sectionTitle: {
    letterSpacing: 0.7,
    flexShrink: 1,
  },
  workspaceCard: {},
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
    overflow: 'hidden',
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
