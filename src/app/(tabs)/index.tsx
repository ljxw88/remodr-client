import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { EmptyState } from '@/components/ui/empty-state';
import { Screen } from '@/components/ui/screen';
import { ScrollEdgeFrame } from '@/components/ui/scroll-edge-frame';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import {
  providerLabel,
  statusLabel,
  type AgentWorkspace,
  type RemoteAgent,
} from '@/domain/herdr';
import { connectAgentRuntime } from '@/features/agents/connect-runtime';
import { AgentProviderIcon } from '@/features/agents/agent-provider-icon';
import { NewAgentSheet } from '@/features/agents/new-agent-sheet';
import { useHerdr } from '@/features/agents/use-herdr';
import {
  useDockContentInset,
  useDockScrollHandler,
} from '@/features/navigation/floating-dock';
import { useHostSession } from '@/features/connection/use-host-session';
import { useHosts } from '@/features/hosts/use-hosts';
import { useTheme } from '@/hooks/use-theme';
import { herdrRepository } from '@/services/herdr-repository';
import { toUserMessage } from '@/utils/user-error';

export default function AgentsScreen() {
  const theme = useTheme();
  const state = useHerdr();
  const { hosts, loading: hostsLoading } = useHosts();
  const onDockScroll = useDockScrollHandler();
  const dockContentInset = useDockContentInset();
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [switchingDeviceId, setSwitchingDeviceId] = useState<string | null>(null);
  const deviceSelectionVersion = useRef(0);
  const selectedDeviceId = state.selectedDeviceId ?? state.runtime.deviceId ?? null;
  const selectedHost = hosts.find((host) => host.id === selectedDeviceId);
  const runtimeMatchesDevice =
    !selectedDeviceId || state.runtime.deviceId === selectedDeviceId;
  const connected = state.connection === 'connected' && runtimeMatchesDevice;
  const busy =
    switchingDeviceId != null ||
    [
      'connecting',
      'authenticating',
      'starting_bridge',
      'synchronizing',
      'reconnecting',
    ].includes(state.connection);
  const spaces = runtimeMatchesDevice ? state.runtime.workspaces : [];
  const activeSpaceId =
    selectedSpaceId && spaces.some((space) => space.id === selectedSpaceId)
      ? selectedSpaceId
      : null;
  const visibleAgents = useMemo(
    () =>
      state.runtime.agents
        .filter(
          (agent) =>
            runtimeMatchesDevice &&
            (!activeSpaceId || agent.workspaceId === activeSpaceId),
        )
        .sort(compareAgents),
    [activeSpaceId, runtimeMatchesDevice, state.runtime.agents],
  );
  const sections = useMemo(() => {
    const spacesInScope = activeSpaceId
      ? spaces.filter((space) => space.id === activeSpaceId)
      : spaces;
    const result = spacesInScope.map((space) => ({
      space,
      agents: visibleAgents.filter((agent) => agent.workspaceId === space.id),
    }));
    const knownSpaceIds = new Set(spaces.map((space) => space.id));
    const unassigned = visibleAgents.filter((agent) => !knownSpaceIds.has(agent.workspaceId));
    if (unassigned.length > 0 && !activeSpaceId) {
      result.push({
        space: {
          id: 'unassigned',
          name: 'Other',
          status: 'unknown',
        },
        agents: unassigned,
      });
    }
    return result.filter((section) => section.agents.length > 0);
  }, [activeSpaceId, spaces, visibleAgents]);

  useFocusEffect(
    useCallback(() => {
      if (state.connection !== 'disconnected' && state.connection !== 'error') {
        return;
      }
      void connectAgentRuntime().catch((error) => {
        console.warn('[HERDR_RUNTIME] Could not connect', error);
      });
    }, [state.connection]),
  );

  const connectionColor = connected ? theme.success : busy ? theme.accent : theme.warning;
  const connectionBackground = connected
    ? theme.successSoft
    : busy
      ? theme.accentSoft
      : theme.warningSoft;
  const canCreateAgent = connected && spaces.length > 0;

  async function selectDevice(deviceId: string) {
    if (deviceId === selectedDeviceId) {
      return;
    }
    const selectionVersion = ++deviceSelectionVersion.current;
    setSelectedSpaceId(null);
    setSwitchingDeviceId(deviceId);
    herdrRepository.selectDevice(deviceId);
    try {
      const connectedDevice = await connectAgentRuntime(deviceId);
      if (selectionVersion !== deviceSelectionVersion.current) {
        return;
      }
      if (!connectedDevice) {
        router.push({ pathname: '/connect/[id]', params: { id: deviceId } });
      }
    } catch (error) {
      if (selectionVersion !== deviceSelectionVersion.current) {
        return;
      }
      Alert.alert('Could not connect device', toUserMessage(error));
    } finally {
      if (selectionVersion === deviceSelectionVersion.current) {
        setSwitchingDeviceId(null);
      }
    }
  }

  return (
    <Screen includeTopSafeArea>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New agent"
          accessibilityState={{ disabled: !canCreateAgent }}
          disabled={!canCreateAgent}
          onPress={() => setShowNewAgent(true)}
          style={({ pressed }) => [
            styles.newAgent,
            {
              backgroundColor: canCreateAgent ? theme.accent : theme.backgroundElement,
              opacity: canCreateAgent ? (pressed ? 0.78 : 1) : 0.42,
            },
          ]}>
          <AppIcon
            name={{ ios: 'plus', android: 'add', web: 'add' }}
            size={18}
            tintColor={canCreateAgent ? theme.onAccent : theme.textMuted}
            fallback="+"
          />
          <ThemedText
            type="smallBold"
            style={{ color: canCreateAgent ? theme.onAccent : theme.textMuted }}>
            New agent
          </ThemedText>
        </Pressable>
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
            {connected ? 'Live' : busy ? 'Connecting' : 'Offline'}
          </ThemedText>
        </View>
      </View>

      {hosts.length > 0 ? (
        <View style={styles.filters}>
          <FilterHeader label="Devices" value={selectedHost?.name} />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.filterRow}>
            {hosts.map((host) => (
              <DeviceChip
                key={host.id}
                hostId={host.id}
                label={host.name}
                selected={host.id === selectedDeviceId}
                disabled={busy}
                onPress={() => void selectDevice(host.id)}
              />
            ))}
          </ScrollView>

          {spaces.length > 0 ? (
            <>
              <FilterHeader
                label="Spaces"
                value={
                  activeSpaceId
                    ? spaces.find((space) => space.id === activeSpaceId)?.name
                    : 'All'
                }
              />
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.filterRow}>
                <FilterChip
                  label="All spaces"
                  selected={activeSpaceId == null}
                  onPress={() => setSelectedSpaceId(null)}
                />
                {spaces.map((space) => (
                  <FilterChip
                    key={space.id}
                    label={space.name}
                    selected={space.id === activeSpaceId}
                    onPress={() => setSelectedSpaceId(space.id)}
                  />
                ))}
              </ScrollView>
            </>
          ) : null}
        </View>
      ) : null}

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
          <Pressable
            onPress={() => {
              void connectAgentRuntime().catch((error) => {
                Alert.alert('Could not reconnect', toUserMessage(error));
              });
            }}>
            <ThemedText type="smallBold" style={{ color: theme.accent }}>
              Retry
            </ThemedText>
          </Pressable>
        </View>
      ) : null}

      {hostsLoading || (busy && !runtimeMatchesDevice) ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.accent} />
          <ThemedText type="small" themeColor="textMuted">
            Loading agents
          </ThemedText>
        </View>
      ) : !selectedHost ? (
        <EmptyState
          title="Choose a device"
          body="Add a server, then select it here to browse its spaces and agents."
          actionLabel="Open servers"
          onAction={() => router.push('/servers')}
        />
      ) : !connected && !busy ? (
        <EmptyState
          title={`${selectedHost.name} is offline`}
          body="Connect this device to load its Herdr spaces and agents."
          actionLabel="Connect device"
          onAction={() =>
            router.push({ pathname: '/connect/[id]', params: { id: selectedHost.id } })
          }
        />
      ) : spaces.length === 0 ? (
        <EmptyState
          title="No spaces available"
          body="Create a workspace in Herdr, then it will appear here automatically."
          actionLabel="Refresh"
          onAction={() => {
            void herdrRepository.refreshRuntime().catch((error) => {
              Alert.alert('Could not refresh spaces', toUserMessage(error));
            });
          }}
        />
      ) : sections.length === 0 ? (
        <EmptyState
          title={activeSpaceId ? 'No agents in this space' : 'No agents available'}
          body="Start an agent and it will appear here as soon as Herdr detects it."
          actionLabel="New agent"
          onAction={() => setShowNewAgent(true)}
        />
      ) : (
        <ScrollEdgeFrame onScroll={onDockScroll}>
          {(onScroll) => (
            <ScrollView
              onScroll={onScroll}
              scrollEventThrottle={16}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={[styles.list, { paddingBottom: dockContentInset }]}>
              {sections.map((section) => (
                <WorkspaceGroup
                  key={section.space.id}
                  space={section.space}
                  agents={section.agents}
                />
              ))}
            </ScrollView>
          )}
        </ScrollEdgeFrame>
      )}
      {showNewAgent ? (
        <NewAgentSheet
          manifests={state.runtime.providers}
          spaces={spaces}
          initialSpaceId={activeSpaceId}
          onClose={() => setShowNewAgent(false)}
          onCreate={async (input) => {
            const result = await herdrRepository.createAgent(input);
            setShowNewAgent(false);
            if (result.agentId) {
              router.push({
                pathname: '/agents/[id]',
                params: { id: result.agentId },
              });
            }
          }}
        />
      ) : null}
    </Screen>
  );
}

function FilterHeader({ label, value }: { label: string; value?: string }) {
  return (
    <View style={styles.filterHeader}>
      <ThemedText type="label" themeColor="textMuted">
        {label.toUpperCase()}
      </ThemedText>
      {value ? (
        <ThemedText type="caption" themeColor="textSecondary" numberOfLines={1}>
          {value}
        </ThemedText>
      ) : null}
    </View>
  );
}

function DeviceChip({
  hostId,
  label,
  selected,
  disabled,
  onPress,
}: {
  hostId: string;
  label: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const session = useHostSession(hostId);
  return (
    <FilterChip
      label={label}
      selected={selected}
      disabled={disabled}
      statusColor={session ? theme.success : theme.textMuted}
      onPress={onPress}
    />
  );
}

function FilterChip({
  label,
  selected,
  disabled = false,
  statusColor,
  onPress,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  statusColor?: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.filterChip,
        {
          backgroundColor: selected ? theme.accentSoft : theme.backgroundElement,
          borderColor: selected ? theme.accent : theme.border,
          opacity: disabled ? 0.5 : pressed ? 0.72 : 1,
        },
      ]}>
      {statusColor ? (
        <View style={[styles.deviceDot, { backgroundColor: statusColor }]} />
      ) : null}
      <ThemedText
        type="caption"
        numberOfLines={1}
        style={{ color: selected ? theme.accent : theme.textSecondary }}>
        {label}
      </ThemedText>
    </Pressable>
  );
}

function WorkspaceGroup({ space, agents }: { space: AgentWorkspace; agents: RemoteAgent[] }) {
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
        <AgentProviderIcon provider={agent.provider} tintColor={theme.accent} />
      </View>
      <View style={styles.agentCopy}>
        <View style={styles.agentTitle}>
          <ThemedText type="section" numberOfLines={1} style={styles.providerName}>
            {agent.title}
          </ThemedText>
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

function compareAgents(left: RemoteAgent, right: RemoteAgent) {
  const priority: Record<RemoteAgent['status'], number> = {
    blocked: 0,
    done: 1,
    working: 2,
    idle: 3,
    unknown: 4,
  };
  return priority[left.status] - priority[right.status] || left.title.localeCompare(right.title);
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    marginBottom: Spacing.two,
  },
  newAgent: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    borderRadius: Radius.pill,
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
  filters: {
    gap: Spacing.one,
    marginBottom: Spacing.three,
  },
  filterHeader: {
    minHeight: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingHorizontal: Spacing.half,
  },
  filterRow: {
    gap: Spacing.one,
    paddingRight: Spacing.two,
  },
  filterChip: {
    minHeight: 38,
    maxWidth: 190,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.half,
    paddingHorizontal: Spacing.one + Spacing.half,
    borderWidth: 1,
    borderRadius: Radius.pill,
  },
  deviceDot: {
    width: 6,
    height: 6,
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
    paddingTop: Spacing.one,
  },
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
