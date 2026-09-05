import { router, Stack, useFocusEffect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { MarkdownMessage } from '@/components/markdown/markdown-message';
import { MessageText } from '@/components/markdown/markdown-theme';
import { AppIcon } from '@/components/ui/app-icon';
import { GlassSurface } from '@/components/ui/glass-surface';
import { Screen } from '@/components/ui/screen';
import { ScrollEdgeFrame } from '@/components/ui/scroll-edge-frame';
import { ThemedText } from '@/components/themed-text';
import { Colors, Fonts, Radius, ScrollEdgeFade, Spacing } from '@/constants/theme';
import {
  providerLabel,
  statusLabel,
  type ConversationItem,
  type AgentProvider,
  type AgentTuning,
  type HumanRequest,
  type RemoteAgent,
} from '@/domain/herdr';
import { EFFORT_LABELS, modelLabel, supportsTuning } from '@/domain/agent-catalogue';
import { beginAgentSettingsFlow, beginRenameAgentFlow } from '@/features/agents/agent-edit-flow';
import { ActionMenu } from '@/components/ui/action-menu';
import { HumanRequestBar } from '@/features/agents/human-request-bar';
import { useAgentConversation, useHerdr } from '@/features/agents/use-herdr';
import { conversationRefreshInterval, startConversationRefresh } from '@/features/agents/conversation-refresh';
import { CommandDelivery, ConnectionStatus } from '@/features/connection/connection-status';
import { useConnectionSnapshot, useForeground, usePendingCommands } from '@/features/connection/use-connection';
import {
  groupToolActivity,
  currentToolActivity,
  toolActivitySummary,
  type ConversationDisplayItem,
  type ToolActivityGroup,
} from '@/features/agents/conversation-display';
import { useTheme } from '@/hooks/use-theme';
import { useKeyboardOverlap } from '@/hooks/use-keyboard-overlap';
import { isBridgeUnavailable } from '@/services/herdr-bridge-transport';
import { herdrRepository } from '@/services/herdr-repository';
import { toUserMessage } from '@/utils/user-error';

export default function AgentConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const runtime = useHerdr();
  const agent = Object.values(runtime.devices)
    .flatMap((device) => device.runtime.agents)
    .find((item) => item.id === id);
  const agentId = agent?.id;
  const agentStatus = agent?.status;
  const conversation = useAgentConversation(id ?? '');
  // A cached runtime can name an agent well before its device transport is up,
  // and a conversation fetched in that window throws. Following the owning
  // device's connection gives the fetch a trigger to run again on.
  const ownerDeviceId = herdrRepository.deviceIdForAgent(id ?? '');
  const ownerConnection = ownerDeviceId
    ? runtime.devices[ownerDeviceId]?.connection
    : undefined;
  const ownerSnapshot = useConnectionSnapshot(ownerDeviceId);
  const foreground = useForeground();
  const focused = useIsFocused();
  const { ref: keyboardViewport, inset: keyboardHeight, measure: measureKeyboard } = useKeyboardOverlap(focused && foreground);
  const commands = usePendingCommands();
  const ownerConnected = ownerConnection === 'connected' &&
    (!ownerSnapshot || ownerSnapshot.phase === 'connected');
  const [draft, setDraft] = useState('');
  const [draftReadyFor, setDraftReadyFor] = useState<string | null>(null);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [sending, setSending] = useState(false);
  const [composerHeight, setComposerHeight] = useState(0);
  const [closingAgent, setClosingAgent] = useState(false);
  const closingAgentRef = useRef(false);
  const navigating = useRef(false);
  const actionVisible = useRef(false);
  const mounted = useRef(false);
  const listRef = useRef<FlatList<ConversationDisplayItem>>(null);
  const sendingRef = useRef(false);
  const draftRevision = useRef(0);
  const refreshRef = useRef<Promise<void> | null>(null);
  const requestId = conversation?.activeHumanRequest?.id;
  const answerPending = commands.some((command) =>
    command.agentId === id && command.action === 'human_request.answer' &&
    command.payload.requestId === requestId,
  );

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useFocusEffect(useCallback(() => {
    navigating.current = false;
    actionVisible.current = true;
    return () => { actionVisible.current = false; };
  }, []));

  function openAgentForm(kind: 'settings' | 'rename') {
    if (!agent || navigating.current || closingAgentRef.current) return;
    try {
      const flowId = kind === 'settings' ? beginAgentSettingsFlow(agent) : beginRenameAgentFlow(agent);
      navigating.current = true;
      Keyboard.dismiss();
      router.push({ pathname: kind === 'settings' ? '/flows/agent-settings' : '/flows/rename-agent', params: { flowId } });
    } catch (error) {
      navigating.current = false;
      Alert.alert('Could not open agent options', toUserMessage(error));
    }
  }

  function confirmCloseAgent() {
    if (!agent || closingAgentRef.current) return;
    const target = agent;
    Alert.alert('Close this agent?', `${target.title} will stop, and its conversation will no longer be reachable.`, [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Close agent', style: 'destructive',
        onPress: () => {
          if (closingAgentRef.current) return;
          closingAgentRef.current = true;
          setClosingAgent(true);
          void herdrRepository.closeAgent(target.id).then(() => {
            if (actionVisible.current) router.dismissTo('/');
          }).catch((error) => {
            if (actionVisible.current) Alert.alert('Could not close agent', toUserMessage(error));
            else console.warn('[AGENT] Could not close agent', error);
          }).finally(() => {
            closingAgentRef.current = false;
            if (mounted.current) setClosingAgent(false);
          });
        },
      },
    ]);
  }

  function changeDraft(text: string) {
    draftRevision.current++;
    setDraft(text);
    setSendError(null);
  }

  useEffect(() => {
    if (!focused || !foreground) return;
    const subscription = Keyboard.addListener('keyboardDidShow', () => {
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    });
    return () => subscription.remove();
  }, [focused, foreground]);
  /**
   * Newest first, because the transcript renders inverted. Offset zero is then
   * the newest message, so opening a conversation lands at the bottom by
   * construction rather than by scrolling there once the rows have measured.
   */
  const displayItems = useMemo(
    () => groupToolActivity(conversation?.items ?? []).reverse(),
    [conversation?.items],
  );
  const activeTool = currentToolActivity(conversation?.items ?? [], agentStatus);
  const working = agentStatus === 'working';
  const workingLabel = activeTool?.title
    ? `${activeTool.title}…`
    : `${agent ? providerLabel(agent.provider) : 'The agent'} is working`;
  const hasOpenRequest = conversation?.activeHumanRequest != null;

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void herdrRepository.restoreConversation(id).catch((error) => {
      if (!cancelled) setConversationError(toUserMessage(error));
    });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (!id) {
      return;
    }
    let cancelled = false;
    const revision = draftRevision.current;
    void herdrRepository
      .loadDraft(id)
      .then((saved) => {
        if (!cancelled && draftRevision.current === revision) setDraft(saved);
        if (!cancelled) setDraftReadyFor(id);
      })
      .catch((error) => {
        console.warn('[CONVERSATION] Could not load draft', error);
        if (!cancelled) setSendError('Could not restore the saved draft. Existing saved text has not been replaced.');
      });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (!agentId || !ownerConnected || !foreground || !focused) {
      return;
    }
    return startConversationRefresh({
      interval: conversationRefreshInterval(
        agentStatus, hasOpenRequest, agent?.capabilities.streamingConversation === true,
      ),
      inFlight: refreshRef,
      refresh: () => herdrRepository.loadConversation(agentId),
      onSuccess: () => setConversationError(null),
      onError: (error) => {
        console.warn('[CONVERSATION] Could not load conversation', error);
        setConversationError(
          isBridgeUnavailable(error)
            ? 'Not connected to this agent’s device.'
            : toUserMessage(error),
        );
      },
    });
  }, [
    agent?.capabilities.streamingConversation,
    agentId,
    agentStatus,
    hasOpenRequest,
    ownerConnected,
    foreground,
    focused,
    reloadToken,
  ]);

  useEffect(() => {
    if (!id || draftReadyFor !== id) {
      return;
    }
    const timer = setTimeout(() => {
      void herdrRepository.saveDraft(id, draft).catch((error) => {
        console.warn('[CONVERSATION] Could not save draft', error);
      });
    }, 250);
    return () => {
      clearTimeout(timer);
      void herdrRepository.saveDraft(id, draft).catch((error) => {
        console.warn('[CONVERSATION] Could not save draft', error);
      });
    };
  }, [draft, draftReadyFor, id]);

  if (!agent) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Agent' }} />
        <ThemedText>This agent is no longer available.</ThemedText>
      </Screen>
    );
  }

  async function send() {
    const text = draft.trim();
    if (!text || sendingRef.current || !agent) {
      return;
    }
    if (requestId && herdrRepository.getPendingCommands().some((command) =>
      command.agentId === agent.id && command.action === 'human_request.answer' &&
      command.payload.requestId === requestId,
    )) {
      setSendError('An answer is already queued. Review its delivery status before answering again.');
      return;
    }
    sendingRef.current = true;
    const revision = draftRevision.current;
    setSending(true);
    setSendError(null);
    try {
      if (conversation?.activeHumanRequest) {
        await herdrRepository.answerHumanRequest(
          agent.id,
          conversation.activeHumanRequest.id,
          { customText: text },
        );
      } else {
        await herdrRepository.sendMessage(agent.id, text);
      }
      if (draftRevision.current === revision) setDraft('');
      // The one scroll left in this screen, and the only one that is asked
      // for: sending is a statement that you want to watch the reply. On an
      // inverted list offset zero is the newest message, so unlike
      // `scrollToEnd` this cannot land halfway up a list still measuring
      // itself.
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    } catch (error) {
      setSendError(toUserMessage(error));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  return (
    <Screen style={styles.screen}>
      <Stack.Screen
        options={{
          title: agent.title,
          headerTitleStyle: {
            fontSize: 15,
            fontFamily: Fonts.semibold,
            fontWeight: 600,
          },
          /**
           * The only sign that the agent is busy. It used to be a labelled row
           * above the composer, which took a band of the transcript for a
           * sentence that said what the spinner already says, and moved the
           * composer every time the agent started or stopped.
           *
           * The label lives on for screen readers, which get nothing from a
           * spinner on its own.
           */
          headerRight: () => (
            <View style={styles.headerActions}>
              {working ? (
                <ActivityIndicator
                  size="small"
                  color={Colors.accent}
                  accessibilityLabel={workingLabel}
                />
              ) : null}
              <ActionMenu
                label="Agent options"
                disabled={closingAgent}
                items={[
                  { id: 'rename', label: 'Rename agent', onPress: () => openAgentForm('rename') },
                  { id: 'settings', label: 'Model settings', disabled: !supportsTuning(agent.provider), onPress: () => openAgentForm('settings') },
                  { id: 'close', label: 'Close agent', destructive: true, disabled: !ownerConnected, onPress: confirmCloseAgent },
                ]}
              />
            </View>
          ),
        }}
      />
      <View ref={keyboardViewport} onLayout={measureKeyboard} collapsable={false} style={styles.flex}>
        {/* ScrollEdgeFrame supplies the transcript blur target. Keep the
            composer and reconnect overlay outside it. */}
        <View style={styles.flex}>
          <AgentHeader agent={agent} connected={ownerConnected} />
          <ScrollEdgeFrame
            inverted
            // The fade is what stops rows reading through the gaps between the
            // composer's stacked panels, so it has to reach as far as they do.
            bottomHeight={Math.max(
              ScrollEdgeFade.bottomHeight,
              composerHeight + keyboardHeight,
            )}>
            {(edge) => (
              <FlatList
                {...edge}
                ref={listRef}
                inverted
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="on-drag"
                data={displayItems}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => (
                  <ConversationRow
                    item={item}
                    agent={agent}
                    onEdit={changeDraft}
                  />
                )}
                showsVerticalScrollIndicator={false}
                initialNumToRender={20}
                maxToRenderPerBatch={20}
                windowSize={7}
                contentContainerStyle={styles.messages}
                /**
                 * Holds the reader's place when a message grows or older
                 * history arrives, instead of shifting the viewport under them.
                 *
                 * `autoscrollToTopThreshold` is what makes it follow again once
                 * they are back at the newest message — "top" here means the
                 * start of the content, which on an inverted list is the bottom
                 * of the screen. Without it, a reply that grows while you are
                 * watching it stays pinned by its first line and writes itself
                 * off the bottom of the screen.
                 */
                maintainVisibleContentPosition={{
                  minIndexForVisible: 0,
                  autoscrollToTopThreshold: 24,
                }}
                // Inverted, so this sits below the newest message. It is
                // measured rather than guessed because the composer grows: a
                // pending question, the working row and a wrapped draft all
                // change its height, and a fixed spacer lets it cover the
                // newest message.
                ListHeaderComponent={
                  <View style={{ height: composerHeight + keyboardHeight }} />
                }
                ListEmptyComponent={
                  <View style={styles.empty}>
                    {conversationError ? (
                      <>
                        <ThemedText type="small" themeColor="textMuted">
                          {conversationError}
                        </ThemedText>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel="Retry loading conversation"
                          onPress={() => setReloadToken((token) => token + 1)}>
                          <ThemedText type="smallBold" style={styles.retry}>
                            Try again
                          </ThemedText>
                        </Pressable>
                      </>
                    ) : conversation ? (
                      <ThemedText type="small" themeColor="textMuted">
                        No conversation yet.
                      </ThemedText>
                    ) : ownerConnected ? (
                      <ActivityIndicator color={Colors.accent} />
                    ) : (
                      <ThemedText type="small" themeColor="textMuted">
                        Conversation will load when this device reconnects.
                      </ThemedText>
                    )}
                  </View>
                }
              />
            )}
          </ScrollEdgeFrame>
        </View>
        <Composer
          value={draft}
          onChangeText={changeDraft}
          onSend={() => void send()}
          sending={sending}
          enqueueGuard={sendingRef}
          answerPending={answerPending}
          error={sendError}
          agentId={agent.id}
          request={conversation?.activeHumanRequest ?? null}
          onHeightChange={setComposerHeight}
          provider={agent.provider}
          tuning={agent.tuning}
          tunable={supportsTuning(agent.provider)}
          onOpenTuning={() => openAgentForm('settings')}
          keyboardOffset={keyboardHeight}
        />
        <ConnectionStatus
          deviceId={ownerDeviceId}
          agentId={agent.id}
          bottomInset={composerHeight + keyboardHeight}
        />
      </View>
    </Screen>
  );
}

function AgentHeader({ agent, connected }: { agent: RemoteAgent; connected: boolean }) {
  const theme = useTheme();
  const statusColor =
    agent.status === 'working'
      ? theme.accent
      : agent.status === 'blocked'
        ? theme.warning
        : agent.status === 'done'
          ? theme.success
          : theme.textMuted;
  return (
    <View style={[styles.context, { borderBottomColor: theme.border }]}>
      <View style={styles.contextCopy}>
        <ThemedText
          type="caption"
          themeColor="textSecondary"
          numberOfLines={1}
          style={styles.pathText}>
          {agent.cwd ?? agent.workspaceName}
        </ThemedText>
        <View style={styles.rightGroup}>
          <View style={styles.statusLine}>
            <View
              style={[
                styles.statusDot,
                {
                  backgroundColor: agent.status === 'idle' ? 'transparent' : statusColor,
                  borderColor: statusColor,
                },
              ]}
            />
            <ThemedText type="caption" style={{ color: statusColor }}>
              {statusLabel(agent.status)}
            </ThemedText>
          </View>
          {agent.status === 'working' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop current agent operation"
              accessibilityHint={connected ? undefined : 'Reconnect before stopping this operation'}
              accessibilityState={{ disabled: !connected }}
              disabled={!connected}
              onPress={() => {
                void herdrRepository.interrupt(agent.id).catch((error) => {
                  Alert.alert(
                    'Could not stop agent',
                    error instanceof Error ? error.message : 'The agent could not be stopped.',
                  );
                });
              }}
              style={({ pressed }) => [styles.stop, { borderColor: theme.border, opacity: connected ? 1 : 0.4 }, pressed && styles.pressed]}>
              <ThemedText type="caption" style={styles.stopText}>Stop</ThemedText>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

function ConversationRow({
  item,
  agent,
  onEdit,
}: {
  item: ConversationDisplayItem;
  agent: RemoteAgent;
  onEdit: (text: string) => void;
}) {
  const theme = useTheme();

  if (item.kind === 'tool_group') {
    return <ToolActivityGroupRow group={item} />;
  }

  if (item.kind === 'user_message') {
    return (
      <Pressable
        onLongPress={() => {
          if (item.delivery && item.delivery !== 'sent') return;
          Alert.alert('Message', undefined, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Edit & resend', onPress: () => onEdit(item.text) },
          ]);
        }}
        style={styles.userWrap}>
        <View
          style={[
            styles.userMessage,
            { backgroundColor: theme.glassStrong, borderColor: theme.glassBorder },
          ]}>
          {/* The same size the agent's replies read at, so one side of the
              conversation does not look louder than the other. */}
          <ThemedText selectable style={MessageText}>
            {item.text}
          </ThemedText>
        </View>
        <CommandDelivery
          commandId={item.commandId}
          delivery={item.delivery}
          deliveryError={item.deliveryError}
        />
      </Pressable>
    );
  }

  if (item.kind === 'assistant_message') {
    return (
      <View style={styles.assistantMessage}>
        <MarkdownMessage>{item.markdown}</MarkdownMessage>
      </View>
    );
  }

  if (item.kind === 'tool_activity') {
    return <ToolActivityRow item={item} />;
  }

  if (item.kind === 'human_request') {
    // Pinned above the composer while it is open, so the transcript carries
    // only the record of one already answered — otherwise the same question
    // would be on screen twice, and the copy that scrolls away is the one
    // without any buttons.
    return item.resolved ? <AskedQuestionRow request={item.request} /> : null;
  }

  if (item.kind === 'todo_update') {
    return (
      <View
        style={[
          styles.plan,
          { backgroundColor: theme.backgroundElement, borderColor: theme.border },
        ]}>
        <View style={styles.toolCopy}>
          <ThemedText type="smallBold">Plan</ThemedText>
          {item.todos.map((todo) => (
            <ThemedText key={todo.id ?? todo.text} type="caption" themeColor="textSecondary">
              {todo.state === 'done' ? '✓' : '○'} {todo.text}
            </ThemedText>
          ))}
        </View>
      </View>
    );
  }

  if (item.kind === 'raw_output') {
    return <RawOutputRow item={item} />;
  }

  return (
    <ThemedText type="caption" themeColor="textMuted">
      {item.text ?? statusLabel(item.status)}
    </ThemedText>
  );
}

function RawOutputRow({
  item,
}: {
  item: Extract<ConversationItem, { kind: 'raw_output' }>;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  return (
    <View
      style={[
        styles.raw,
        { backgroundColor: theme.backgroundElement, borderColor: theme.border },
      ]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded((current) => !current)}
        style={({ pressed }) => [styles.rawSummary, pressed && styles.pressed]}>
        <AppIcon
          name={{ ios: 'terminal', android: 'terminal', web: 'terminal' }}
          size={16}
          tintColor={theme.textMuted}
          fallback="›_"
        />
        <View style={styles.rawCopy}>
          <ThemedText type="smallBold">Agent output</ThemedText>
          <ThemedText type="caption" themeColor="textMuted">
            Compatibility view
          </ThemedText>
        </View>
        <AppIcon
          name={{
            ios: expanded ? 'chevron.up' : 'chevron.right',
            android: expanded ? 'expand_less' : 'chevron_right',
            web: expanded ? 'expand_less' : 'chevron_right',
          }}
          size={16}
          tintColor={theme.textMuted}
          fallback={expanded ? '⌃' : '›'}
        />
      </Pressable>
      {expanded ? (
        <View style={[styles.rawDetails, { borderTopColor: theme.border }]}>
          <ThemedText type="code" selectable>
            {item.text}
          </ThemedText>
        </View>
      ) : null}
    </View>
  );
}

function ToolActivityRow({
  item,
}: {
  item: Extract<ConversationItem, { kind: 'tool_activity' }>;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      onPress={() => setExpanded((current) => !current)}
      style={({ pressed }) => [
        styles.tool,
        {
          backgroundColor: theme.backgroundElement,
          borderColor: theme.border,
          opacity: pressed ? 0.72 : 1,
        },
      ]}>
      <AppIcon
        name={{ ios: 'hammer', android: 'build', web: 'build' }}
        size={16}
        tintColor={theme.textMuted}
        fallback="•"
      />
      <View style={styles.toolCopy}>
        <ThemedText type="smallBold">{item.title}</ThemedText>
        {expanded && item.detail ? (
          <ThemedText type="caption" themeColor="textSecondary">
            {item.detail}
          </ThemedText>
        ) : null}
      </View>
      <ThemedText type="caption" themeColor="textMuted">
        {toolStateLabel(item.state)}
      </ThemedText>
      <AppIcon
        name={{
          ios: expanded ? 'chevron.up' : 'chevron.down',
          android: expanded ? 'expand_less' : 'expand_more',
          web: expanded ? 'expand_less' : 'expand_more',
        }}
        size={16}
        tintColor={theme.textMuted}
        fallback={expanded ? '⌃' : '⌄'}
      />
    </Pressable>
  );
}

function ToolActivityGroupRow({ group }: { group: ToolActivityGroup }) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  return (
    <View
      style={[
        styles.toolGroup,
        { backgroundColor: theme.backgroundElement, borderColor: theme.border },
      ]}>
      <ToolGroupToggle
        group={group}
        expanded={expanded}
        onPress={() => setExpanded((current) => !current)}
      />
      {expanded ? (
        <View style={[styles.toolDetails, { borderTopColor: theme.border }]}>
          {group.items.map((item) => (
            <ToolActivityRow key={item.id} item={item} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ToolGroupToggle({
  group,
  expanded = false,
  onPress,
}: {
  group: ToolActivityGroup;
  expanded?: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={expanded ? 'Collapse tool calls' : 'Expand tool calls'}
      accessibilityState={{ expanded }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.toolSummary,
        pressed && styles.pressed,
      ]}>
      <AppIcon
        name={{ ios: 'hammer', android: 'build', web: 'build' }}
        size={16}
        tintColor={theme.textMuted}
        fallback="•"
      />
      <ThemedText type="smallBold" style={styles.toolSummaryLabel}>
        {toolActivitySummary(group)}
      </ThemedText>
      <AppIcon
        name={{
          ios: expanded ? 'chevron.up' : 'chevron.right',
          android: expanded ? 'expand_less' : 'chevron_right',
          web: expanded ? 'expand_less' : 'chevron_right',
        }}
        size={16}
        tintColor={theme.textMuted}
        fallback={expanded ? '⌃' : '›'}
      />
    </Pressable>
  );
}

function toolStateLabel(
  state: Extract<ConversationItem, { kind: 'tool_activity' }>['state'],
) {
  switch (state) {
    case 'completed':
      return 'Done';
    case 'running':
      return 'Running';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return '';
  }
}

/**
 * A question the agent asked, as a record in the transcript.
 *
 * The answering happens in the bar above the composer, so this carries no
 * controls: two sets of buttons for one question invite the user to tap the
 * pair that has scrolled out of sight. The answer follows as the next user
 * message, which leaves the exchange readable in order.
 */
function AskedQuestionRow({ request }: { request: HumanRequest }) {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.request,
        { backgroundColor: theme.glassStrong, borderColor: theme.glassBorder },
      ]}>
      <ThemedText type="label" themeColor="textMuted">
        ASKED YOU
      </ThemedText>
      {/* The weight and size a message reads at. The card and its label
          already mark this out, so the question needs no emphasis of its own. */}
      <ThemedText type="small">{request.question}</ThemedText>
    </View>
  );
}

/** One of the small chips under the input, showing a setting and opening it. */
function TuningPill({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Model options: ${label}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        {
          backgroundColor: pressed
            ? 'rgba(255, 255, 255, 0.12)'
            : 'rgba(255, 255, 255, 0.06)',
          borderColor: theme.glassBorder,
          opacity: disabled ? 0.5 : 1,
        },
      ]}>
      <ThemedText
        type="smallBold"
        numberOfLines={1}
        style={{ color: theme.text, fontSize: 13 }}>
        {label}
      </ThemedText>
      {disabled ? null : (
        <AppIcon
          name={{ ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }}
          size={14}
          tintColor={theme.textSecondary}
          fallback="⌄"
        />
      )}
    </Pressable>
  );
}

const MIN_INPUT_HEIGHT = 38;
const MAX_INPUT_HEIGHT = 120;

function Composer({
  value,
  onChangeText,
  onSend,
  sending,
  enqueueGuard,
  answerPending,
  error,
  agentId,
  request,
  onHeightChange,
  provider,
  tuning,
  tunable,
  onOpenTuning,
  keyboardOffset = 0,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  sending: boolean;
  enqueueGuard: { current: boolean };
  answerPending: boolean;
  error: string | null;
  agentId: string;
  request: HumanRequest | null;
  onHeightChange: (height: number) => void;
  provider: AgentProvider;
  tuning?: AgentTuning;
  tunable: boolean;
  onOpenTuning: () => void;
  keyboardOffset?: number;
}) {
  const theme = useTheme();

  return (
    <View
      style={[styles.composer, { bottom: keyboardOffset }]}
      onLayout={(event) => onHeightChange(event.nativeEvent.layout.height)}>
      {request ? (
        // Last before the card, because it tucks itself underneath it — any
        // sibling in between would be dragged under there too.
        //
        // Keyed so a new question starts with a clean slate rather than
        // inheriting the last one's half-made selection.
        <HumanRequestBar
          key={request.id}
          agentId={agentId}
          request={request}
          enqueueing={sending}
          enqueueGuard={enqueueGuard}
        />
      ) : null}
      <View style={styles.cardWrapper}>
        <GlassSurface
          tone="chrome"
          strength="strong"
          highlight
          style={styles.cardSurface}>
          <View style={styles.cardContent}>
            <View style={styles.cardTop}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add context"
                onPress={() => {
                  onChangeText(value ? (value.endsWith(' ') ? `${value}@` : `${value} @`) : '@');
                }}
                style={({ pressed }) => [
                  styles.atButton,
                  {
                    backgroundColor: pressed ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.06)',
                    borderColor: theme.glassBorder,
                  },
                ]}>
                <ThemedText style={styles.atText}>@</ThemedText>
              </Pressable>
            </View>

            <TextInput
              accessibilityLabel={request ? 'Write an answer' : 'Build anything'}
              multiline
              blurOnSubmit={false}
              textAlignVertical="top"
              maxLength={20_000}
              value={value}
              onChangeText={onChangeText}
              placeholder={answerPending ? 'Answer queued…' : request ? 'Write another answer…' : 'Build anything…'}
              placeholderTextColor={theme.placeholder}
              style={[styles.input, { color: theme.text }]}
            />
            {error ? (
              <ThemedText type="caption" themeColor="danger" accessibilityLiveRegion="polite">
                {error}
              </ThemedText>
            ) : null}

            <View style={styles.cardBottom}>
              <View style={styles.pillsRow}>
                {/*
                  What the agent is running, and the way to change it. The
                  model is the one setting the agent reports itself, so it is
                  shown even for an agent this app did not start.
                */}
                <TuningPill
                  label={modelLabel(provider, tuning?.model)}
                  onPress={onOpenTuning}
                  disabled={!tunable}
                />
                {tunable && tuning?.effort ? (
                  <TuningPill
                    label={EFFORT_LABELS[tuning.effort]}
                    onPress={onOpenTuning}
                  />
                ) : null}
              </View>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send"
                accessibilityState={{ disabled: !value.trim() || sending || answerPending }}
                disabled={!value.trim() || sending || answerPending}
                onPress={onSend}
                style={({ pressed }) => [
                  styles.send,
                  {
                    backgroundColor: value.trim() && !sending && !answerPending ? theme.accent : 'rgba(255, 255, 255, 0.08)',
                    opacity: pressed ? 0.75 : 1,
                  },
                ]}>
                <AppIcon
                  name={{ ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' }}
                  size={18}
                  tintColor={value.trim() && !sending && !answerPending ? theme.onAccent : theme.textMuted}
                  fallback="↑"
                />
              </Pressable>
            </View>
          </View>
        </GlassSurface>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    paddingHorizontal: 0,
    paddingTop: 0,
  },
  flex: {
    flex: 1,
  },
  context: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingVertical: 2,
    borderBottomWidth: 0,
  },
  contextCopy: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  rightGroup: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + Spacing.half,
  },
  pathText: {
    flexShrink: 1,
  },
  statusLine: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderWidth: 1,
    borderRadius: 3,
  },
  stop: {
    minHeight: 24,
    justifyContent: 'center',
    paddingHorizontal: Spacing.one + Spacing.half,
    borderWidth: 1,
    borderRadius: Radius.pill,
  },
  stopText: {
    fontFamily: Fonts.semibold,
    fontWeight: 600,
  },
  messages: {
    flexGrow: 1,
    gap: Spacing.three,
    paddingHorizontal: Spacing.two,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
  },
  userWrap: {
    alignSelf: 'flex-end',
    maxWidth: '88%',
    alignItems: 'flex-end',
  },
  userMessage: {
    paddingHorizontal: Spacing.two,
    paddingVertical: 10,
    borderWidth: 0,
    borderRadius: Radius.glass,
  },
  assistantMessage: {
    gap: Spacing.one,
  },
  tool: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    minHeight: 46,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderRadius: Radius.control,
  },
  toolGroup: {
    borderWidth: 1,
    borderRadius: Radius.control,
    overflow: 'hidden',
  },
  toolSummary: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: 14,
  },
  toolSummaryLabel: {
    flex: 1,
  },
  toolDetails: {
    gap: Spacing.one,
    padding: Spacing.one,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  toolCopy: {
    flex: 1,
    gap: 3,
  },
  request: {
    // The label is a caption for the question, so it sits against it rather
    // than a whole step away.
    gap: Spacing.half,
    padding: Spacing.one + Spacing.half,
    borderWidth: 1,
    // The radius the other transcript cards use. This one was the odd one out,
    // and a wide corner on a card this size crowds its own text.
    borderRadius: Radius.control,
  },
  plan: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    padding: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.control,
  },
  raw: {
    borderWidth: 1,
    borderRadius: Radius.control,
    overflow: 'hidden',
  },
  rawSummary: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: 14,
  },
  rawCopy: {
    flex: 1,
    gap: 2,
  },
  rawDetails: {
    padding: Spacing.two,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginRight: Spacing.one,
  },
  composer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.two,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
    gap: Spacing.one,
  },
  cardWrapper: {
    borderRadius: Radius.glass,
    overflow: 'hidden',
  },
  cardSurface: {
    borderRadius: Radius.glass,
    overflow: 'hidden',
    padding: 0,
  },
  cardContent: {
    paddingHorizontal: Spacing.two,
    paddingTop: Spacing.one + Spacing.half,
    paddingBottom: Spacing.one + Spacing.half,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  atButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  atText: {
    fontSize: 14,
    fontFamily: Fonts.medium,
    fontWeight: '500',
    color: Colors.textSecondary,
    marginTop: -1,
  },
  input: {
    paddingHorizontal: 0,
    paddingTop: 4,
    paddingBottom: 4,
    minHeight: MIN_INPUT_HEIGHT,
    maxHeight: MAX_INPUT_HEIGHT,
    fontFamily: Fonts.regular,
    fontSize: 16,
    textAlignVertical: 'top',
    includeFontPadding: false,
  },
  cardBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: Spacing.one,
    minHeight: 36,
  },
  pillsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: Radius.pill,
    borderWidth: 1,
  },
  send: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    overflow: 'hidden',
  },
  retry: {
    color: Colors.accent,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: Spacing.four,
  },
  pressed: {
    opacity: 0.6,
  },
});
