import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { EmptyState } from '@/components/ui/empty-state';
import { FinishDot } from '@/components/ui/finish-dot';
import { Screen } from '@/components/ui/screen';
import { ScrollEdgeFrame } from '@/components/ui/scroll-edge-frame';
import { ThemedText } from '@/components/themed-text';
import { ChipGeometry, Radius, Spacing } from '@/constants/theme';
import { unreadCompletionCount, unreadCompletionsBySpace } from '@/domain/agent-completion';
import { type AgentWorkspace } from '@/domain/herdr';
import { connectAgentRuntime } from '@/features/agents/connect-runtime';
import { HeaderRoundButton } from '@/features/agents/header-round-button';
import { LiquidGlassButton } from '@/features/agents/liquid-glass-button';
import { glassRim } from '@/components/ui/glass-surface';
import { LiquidGlassRim } from '@/components/ui/liquid-glass-rim';
import { AgentWorkspaceList } from '@/features/agents/agent-workspace-list';
import { agentSections } from '@/features/agents/agent-ordering';
import { startConversationRefresh } from '@/features/agents/conversation-refresh';
import { beginNewAgentFlow, beginNewSpaceFlow } from '@/features/agents/creation-flow';
import { selectWorkspace, useWorkspaceSelection } from '@/features/agents/workspace-selection';
import { useHerdr } from '@/features/agents/use-herdr';
import {
  useDockContentInset,
  useDockScrollHandler,
} from '@/features/navigation/floating-dock';
import { useHostSession } from '@/features/connection/use-host-session';
import { ConnectionStatus } from '@/features/connection/connection-status';
import { useForeground } from '@/features/connection/use-connection';
import { useHosts } from '@/features/hosts/use-hosts';
import { useAppSettings } from '@/hooks/use-app-settings';
import { useTheme } from '@/hooks/use-theme';
import { herdrRepository } from '@/services/herdr-repository';
import { HerdrBridgeRequestError } from '@/services/herdr-bridge-transport';
import { toUserMessage } from '@/utils/user-error';

const CollapseFiltersIcon = {
  ios: 'chevron.up',
  android: 'expand_less',
  web: 'expand_less',
} as const;
const ExpandFiltersIcon = {
  ios: 'chevron.down',
  android: 'expand_more',
  web: 'expand_more',
} as const;

export default function AgentsScreen() {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const state = useHerdr();
  const { hosts, loading: hostsLoading } = useHosts();
  const onDockScroll = useDockScrollHandler();
  const dockContentInset = useDockContentInset();
  const { agentFiltersExpanded, setAgentFiltersExpanded } = useAppSettings();
  const [closingSpaceId, setClosingSpaceId] = useState<string | null>(null);
  const selectedDeviceId = state.selectedDeviceId ?? state.runtime.deviceId ?? null;
  const selectedSpaceId = useWorkspaceSelection(selectedDeviceId);
  const navigating = useRef(false);
  const refresh = useRef<Promise<void> | null>(null);
  const foreground = useForeground();
  const selectedHost = hosts.find((host) => host.id === selectedDeviceId);
  const connected = state.connection === 'connected';
  const spaces = state.runtime.workspaces;
  const activeSpaceId =
    selectedSpaceId && spaces.some((space) => space.id === selectedSpaceId)
      ? selectedSpaceId
      : null;
  const activeSpace = spaces.find((space) => space.id === activeSpaceId);
  const sections = useMemo(
    () => agentSections(state.runtime.agents, spaces, activeSpaceId),
    [activeSpaceId, spaces, state.runtime.agents],
  );
  // "Current device" per the completion contract: this device's own agents,
  // independent of which space is selected, so switching spaces never hides
  // (or looks like it clears) another space's unread finish.
  const unreadBySpace = useMemo(
    () => unreadCompletionsBySpace(state.runtime.agents),
    [state.runtime.agents],
  );
  const unreadOnDevice = useMemo(
    () => unreadCompletionCount(state.runtime.agents),
    [state.runtime.agents],
  );
  const unreadByDevice = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const device of Object.values(state.devices)) {
      counts[device.deviceId] = unreadCompletionCount(device.runtime.agents);
    }
    return counts;
  }, [state.devices]);
  const unreadAcrossDevices = useMemo(
    () => Object.values(unreadByDevice).reduce((sum, count) => sum + count, 0),
    [unreadByDevice],
  );

  const canCreateAgent = connected && spaces.length > 0;
  const canCreateSpace = connected && selectedHost != null;
  const compactHeader = width < 375;

  useFocusEffect(useCallback(() => {
    navigating.current = false;
    if (!connected || !foreground || !selectedDeviceId) return;
    return startConversationRefresh({
      interval: 2000,
      inFlight: refresh,
      refresh: () => herdrRepository.refreshRuntime(selectedDeviceId, true),
      onSuccess: () => undefined,
      onError: (error) => console.warn('[AGENT_ACTIVITY] Could not refresh output activity', error),
    });
  }, [connected, foreground, selectedDeviceId]));

  function startCreation(kind: 'agent' | 'space') {
    if (navigating.current || !selectedDeviceId) return;
    const device = state.devices[selectedDeviceId];
    if (!device || device.connection !== 'connected') return;
    if (kind === 'agent' && !canCreateAgent) return;
    if (kind === 'space' && !canCreateSpace) return;
    navigating.current = true;
    Keyboard.dismiss();
    const flowId = kind === 'agent'
      ? beginNewAgentFlow(device, activeSpaceId) : beginNewSpaceFlow(device.deviceId);
    router.push({ pathname: kind === 'agent' ? '/flows/new-agent' : '/flows/new-space', params: { flowId } });
  }

  /** Selection is local state; the device's bridge is already live. */
  function selectDevice(deviceId: string) {
    if (deviceId === selectedDeviceId) {
      return;
    }
    selectWorkspace(deviceId, null);
    herdrRepository.selectDevice(deviceId);
    if (herdrRepository.isDeviceConnected(deviceId)) {
      return;
    }
    void connectAgentRuntime(deviceId)
      .catch((error) => {
        console.warn('[CONNECTION] Could not select device connection', error);
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
      if (selectedDeviceId && selectedSpaceId === space.id) selectWorkspace(selectedDeviceId, null);
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
          <LiquidGlassButton
            label={compactHeader ? 'Agent' : 'New Agent'}
            disabled={!canCreateAgent}
            onPress={() => startCreation('agent')}
          />
        </View>
        {/*
          The filters are chrome: useful when picking where to look, in the way
          when reading the list. This folds them away and remembers.

          Which way the chevron points is the whole of the state. The section it
          opens is either on screen or it is not, so a fill saying so as well
          would be telling you something you can already see.
        */}
        <View style={styles.headerRoundButtonWrap}>
          <HeaderRoundButton
            icon={agentFiltersExpanded ? CollapseFiltersIcon : ExpandFiltersIcon}
            fallback={agentFiltersExpanded ? '⌃' : '⌄'}
            accessibilityLabel={
              agentFiltersExpanded ? 'Hide devices and spaces' : 'Show devices and spaces'
            }
            expanded={agentFiltersExpanded}
            disabled={hosts.length === 0}
            onPress={() => void setAgentFiltersExpanded(!agentFiltersExpanded)}
          />
          {/*
            Collapsing the filters hides the per-device chips that would
            otherwise say so; this stands in for them so a finish on a device
            you are not looking at stays discoverable.
          */}
          {!agentFiltersExpanded && unreadAcrossDevices > 0 ? (
            <FinishDot
              count={unreadAcrossDevices}
              label={`${unreadAcrossDevices} unread finished ${unreadAcrossDevices === 1 ? 'agent' : 'agents'} across your devices`}
              style={styles.headerRoundButtonBadge}
            />
          ) : null}
        </View>
      </View>

      {hosts.length > 0 && agentFiltersExpanded ? (
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
                unreadCount={unreadByDevice[host.id] ?? 0}
                onPress={() => selectDevice(host.id)}
              />
            ))}
          </ScrollView>

          {spaces.length > 0 || canCreateSpace ? (
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
                  unreadCount={unreadOnDevice}
                  onPress={() => selectedDeviceId && selectWorkspace(selectedDeviceId, null)}
                />
                {spaces.map((space) => (
                  <FilterChip
                    key={space.id}
                    label={space.name}
                    selected={space.id === activeSpaceId}
                    unreadCount={unreadBySpace[space.id] ?? 0}
                    onPress={() => selectedDeviceId && selectWorkspace(selectedDeviceId, space.id)}
                  />
                ))}
                <FilterChip
                  label="+ New Space"
                  selected={false}
                  disabled={!canCreateSpace}
                  onPress={() => startCreation('space')}
                />
              </ScrollView>
            </>
          ) : null}
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
        <EmptyState message={hosts.length === 0 ? 'No devices' : 'Select a device'} />
      ) : spaces.length === 0 ? (
        <EmptyState message={connected ? 'No spaces' : 'Waiting for this device’s spaces'} />
      ) : sections.length === 0 ? (
        <EmptyState message={activeSpaceId ? 'No agents in this space' : 'No agents'} />
      ) : (
        <ScrollEdgeFrame onScroll={onDockScroll}>
          {(edge) => (
            <ScrollView
              {...edge}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={[styles.list, { paddingBottom: dockContentInset }]}>
              <AgentWorkspaceList sections={sections} />
            </ScrollView>
          )}
        </ScrollEdgeFrame>
      )}
      <ConnectionStatus deviceId={selectedDeviceId} bottomInset={dockContentInset} />
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
  unreadCount = 0,
  onPress,
}: {
  hostId: string;
  label: string;
  selected: boolean;
  disabled?: boolean;
  unreadCount?: number;
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
      unreadCount={unreadCount}
      onPress={onPress}
    />
  );
}

function FilterChip({
  label,
  selected,
  disabled = false,
  statusColor,
  unreadCount = 0,
  onPress,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  statusColor?: string;
  unreadCount?: number;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      accessibilityLabel={
        unreadCount > 0
          ? `${label}, ${unreadCount} unread finished ${unreadCount === 1 ? 'agent' : 'agents'}`
          : undefined
      }
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.filterChip,
        glassRim(selected ? theme.accent : undefined),
        {
          backgroundColor: selected ? theme.accentSoft : theme.backgroundElement,
          opacity: disabled ? 0.5 : pressed ? 0.72 : 1,
        },
      ]}>
      {/* Selection quotes the New agent button: the same iridescent rim and
          frosted body, drawn over the accent tint. */}
      {selected ? <LiquidGlassRim active={!disabled} /> : null}
      <View style={styles.filterChipContent}>
        {statusColor ? (
          <View style={[styles.deviceDot, { backgroundColor: statusColor }]} />
        ) : null}
        <ThemedText
          type="caption"
          numberOfLines={1}
          style={{ color: selected ? theme.onAccent : theme.textSecondary, flexShrink: 1 }}>
          {label}
        </ThemedText>
        {unreadCount > 0 ? (
          <FinishDot
            count={unreadCount}
            label={`${unreadCount} unread finished ${unreadCount === 1 ? 'agent' : 'agents'} in ${label}`}
          />
        ) : null}
      </View>
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
  headerRoundButtonWrap: {
    flexShrink: 0,
  },
  headerRoundButtonBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    zIndex: 2,
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
  /**
   * Padding lives on the content, not here. The selected chip lays a Skia
   * canvas over this box with `position: absolute`, and Yoga insets absolute
   * children by their parent's padding — padding here would pull the rim
   * inside the pill instead of tracing its edge.
   */
  filterChip: {
    minHeight: ChipGeometry.minHeight,
    maxWidth: 190,
    justifyContent: 'center',
    borderRadius: Radius.pill,
    overflow: 'hidden',
  },
  filterChipContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ChipGeometry.gap,
    paddingHorizontal: ChipGeometry.paddingHorizontal,
  },
  deviceDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
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
