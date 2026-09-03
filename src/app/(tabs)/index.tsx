import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { EmptyState } from '@/components/ui/empty-state';
import { Screen } from '@/components/ui/screen';
import { ScrollEdgeFrame } from '@/components/ui/scroll-edge-frame';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { type AgentWorkspace } from '@/domain/herdr';
import { connectAgentRuntime } from '@/features/agents/connect-runtime';
import {
  AgentWorkspaceList,
  compareAgents,
} from '@/features/agents/agent-workspace-list';
import { NewAgentSheet } from '@/features/agents/new-agent-sheet';
import { NewSpaceSheet } from '@/features/agents/new-space-sheet';
import { useHerdr } from '@/features/agents/use-herdr';
import {
  useDockContentInset,
  useDockScrollHandler,
} from '@/features/navigation/floating-dock';
import { useHostSession } from '@/features/connection/use-host-session';
import { useHosts } from '@/features/hosts/use-hosts';
import { useTheme } from '@/hooks/use-theme';
import { herdrRepository } from '@/services/herdr-repository';
import { HerdrBridgeRequestError } from '@/services/herdr-bridge-transport';
import { toUserMessage } from '@/utils/user-error';

export default function AgentsScreen() {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const state = useHerdr();
  const { hosts, loading: hostsLoading } = useHosts();
  const onDockScroll = useDockScrollHandler();
  const dockContentInset = useDockContentInset();
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [showNewSpace, setShowNewSpace] = useState(false);
  const [closingSpaceId, setClosingSpaceId] = useState<string | null>(null);
  const selectedDeviceId = state.selectedDeviceId ?? state.runtime.deviceId ?? null;
  const selectedHost = hosts.find((host) => host.id === selectedDeviceId);
  const connected = state.connection === 'connected';
  const busy = [
    'connecting',
    'authenticating',
    'starting_bridge',
    'synchronizing',
    'reconnecting',
  ].includes(state.connection);
  const spaces = state.runtime.workspaces;
  const activeSpaceId =
    selectedSpaceId && spaces.some((space) => space.id === selectedSpaceId)
      ? selectedSpaceId
      : null;
  const activeSpace = spaces.find((space) => space.id === activeSpaceId);
  const visibleAgents = useMemo(
    () =>
      state.runtime.agents
        .filter((agent) => !activeSpaceId || agent.workspaceId === activeSpaceId)
        .sort(compareAgents),
    [activeSpaceId, state.runtime.agents],
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
  const canCreateSpace = connected && selectedHost != null;
  const compactHeader = width < 360;

  /** Selection is local state; the device's bridge is already live. */
  function selectDevice(deviceId: string) {
    if (deviceId === selectedDeviceId) {
      return;
    }
    setSelectedSpaceId(null);
    herdrRepository.selectDevice(deviceId);
    if (herdrRepository.isDeviceConnected(deviceId)) {
      return;
    }
    const stillSelected = () =>
      herdrRepository.getSnapshot().selectedDeviceId === deviceId;
    void connectAgentRuntime(deviceId)
      .then((connectedDevice) => {
        if (!connectedDevice && stillSelected()) {
          router.push({ pathname: '/connect/[id]', params: { id: deviceId } });
        }
      })
      .catch((error) => {
        if (stillSelected()) {
          Alert.alert('Could not connect device', toUserMessage(error));
        }
      });
  }

  function confirmCloseSpace(space: AgentWorkspace) {
    Alert.alert(
      'Close space?',
      `Close ${space.name}? All agents and terminals in this space will be closed.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Close space',
          style: 'destructive',
          onPress: () => {
            void closeSpace(space);
          },
        },
      ],
    );
  }

  async function closeSpace(space: AgentWorkspace, closeGroup = false) {
    setClosingSpaceId(space.id);
    try {
      await herdrRepository.closeSpace(space.id, closeGroup);
      setSelectedSpaceId((current) => current === space.id ? null : current);
    } catch (error) {
      if (
        !closeGroup &&
        error instanceof HerdrBridgeRequestError &&
        error.code === 'workspace_group_close_required'
      ) {
        Alert.alert(
          'Close linked spaces?',
          'This space belongs to a linked workspace group. Closing the group will close every space, agent, and terminal in it.',
          [
            { text: 'Cancel', style: 'cancel' },
            {
              text: 'Close group',
              style: 'destructive',
              onPress: () => {
                void closeSpace(space, true);
              },
            },
          ],
        );
      } else {
        Alert.alert('Could not close space', toUserMessage(error));
      }
    } finally {
      setClosingSpaceId((current) => current === space.id ? null : current);
    }
  }

  return (
    <Screen includeTopSafeArea>
      <View style={styles.header}>
        <View style={styles.headerActions}>
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
              {compactHeader ? 'Agent' : 'New agent'}
            </ThemedText>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="New space"
            accessibilityState={{ disabled: !canCreateSpace }}
            disabled={!canCreateSpace}
            onPress={() => setShowNewSpace(true)}
            style={({ pressed }) => [
              styles.newSpace,
              {
                backgroundColor: theme.glassStrong,
                borderColor: theme.glassBorder,
                opacity: canCreateSpace ? (pressed ? 0.72 : 1) : 0.42,
              },
            ]}>
            <AppIcon
              name={{ ios: 'plus', android: 'add', web: 'add' }}
              size={17}
              tintColor={canCreateSpace ? theme.textSecondary : theme.textMuted}
              fallback="+"
            />
            <ThemedText type="smallBold" themeColor="textSecondary">
              {compactHeader ? 'Space' : 'New space'}
            </ThemedText>
          </Pressable>
        </View>
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
                onPress={() => selectDevice(host.id)}
              />
            ))}
          </ScrollView>

          {spaces.length > 0 ? (
            <>
              <FilterHeader
                label="Spaces"
                value={activeSpace?.name ?? 'All'}
                closing={activeSpace?.id === closingSpaceId}
                onCloseValue={
                  activeSpace ? () => confirmCloseSpace(activeSpace) : undefined
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

      {hostsLoading ? (
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
              <AgentWorkspaceList sections={sections} />
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
      {showNewSpace && selectedHost ? (
        <NewSpaceSheet
          deviceId={selectedHost.id}
          deviceName={selectedHost.name}
          onClose={() => setShowNewSpace(false)}
          onCreate={async (input) => {
            const result = await herdrRepository.createSpace(input);
            setShowNewSpace(false);
            setSelectedSpaceId(result.workspaceId);
            setShowNewAgent(true);
          }}
        />
      ) : null}
    </Screen>
  );
}

function FilterHeader({
  label,
  value,
  closing = false,
  onCloseValue,
}: {
  label: string;
  value?: string;
  closing?: boolean;
  onCloseValue?: () => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.filterHeader}>
      <ThemedText type="label" themeColor="textMuted">
        {label.toUpperCase()}
      </ThemedText>
      {value ? (
        <View style={styles.filterValue}>
          <ThemedText type="caption" themeColor="textSecondary" numberOfLines={1}>
            {value}
          </ThemedText>
          {onCloseValue ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Close ${value} space`}
              disabled={closing}
              onPress={onCloseValue}
              hitSlop={8}
              style={({ pressed }) => [
                styles.closeSpace,
                pressed && styles.pressed,
              ]}>
              {closing ? (
                <ActivityIndicator size="small" color={theme.danger} />
              ) : (
                <AppIcon
                  name={{ ios: 'xmark', android: 'close', web: 'close' }}
                  size={15}
                  tintColor={theme.danger}
                  fallback="×"
                />
              )}
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function DeviceChip({
  hostId,
  label,
  selected,
  disabled = false,
  onPress,
}: {
  hostId: string;
  label: string;
  selected: boolean;
  disabled?: boolean;
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

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.one,
    marginBottom: Spacing.two,
  },
  headerActions: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  newAgent: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.one + Spacing.half,
    borderRadius: Radius.pill,
  },
  newSpace: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.half,
    paddingHorizontal: Spacing.one,
    borderWidth: 1,
    borderRadius: Radius.pill,
  },
  connection: {
    flexShrink: 0,
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
    minHeight: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    paddingHorizontal: Spacing.half,
  },
  filterValue: {
    maxWidth: '62%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.half,
  },
  closeSpace: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.pill,
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
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.one,
  },
  pressed: {
    opacity: 0.6,
  },
});
