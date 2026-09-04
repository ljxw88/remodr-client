import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import { MarkdownMessage } from '@/components/markdown/markdown-message';
import { AppIcon } from '@/components/ui/app-icon';
import {
  BlurBackdropProvider,
  BlurBackdropTarget,
} from '@/components/ui/blur-backdrop';
import { BorderBeam } from '@/components/ui/border-beam';
import { GlassSurface } from '@/components/ui/glass-surface';
import { Screen } from '@/components/ui/screen';
import { ScrollEdgeFrame } from '@/components/ui/scroll-edge-frame';
import { ThemedText } from '@/components/themed-text';
import { Colors, Fonts, Radius, ScrollEdgeFade, Spacing } from '@/constants/theme';
import {
  providerLabel,
  statusLabel,
  type ConversationItem,
  type HumanRequest,
  type RemoteAgent,
} from '@/domain/herdr';
import { HumanRequestBar } from '@/features/agents/human-request-bar';
import { useAgentConversation, useHerdr } from '@/features/agents/use-herdr';
import { useRevealedText } from '@/features/agents/use-revealed-text';
import {
  groupToolActivity,
  toolActivitySummary,
  type ConversationDisplayItem,
  type ToolActivityGroup,
} from '@/features/agents/conversation-display';
import { useTheme } from '@/hooks/use-theme';
import { isBridgeUnavailable } from '@/services/herdr-bridge-transport';
import { herdrRepository } from '@/services/herdr-repository';
import { toUserMessage } from '@/utils/user-error';

export default function AgentConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const runtime = useHerdr();
  const agent = runtime.runtime.agents.find((item) => item.id === id);
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
  const [draft, setDraft] = useState('');
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [sending, setSending] = useState(false);
  const [composerHeight, setComposerHeight] = useState(0);
  const listRef = useRef<FlatList<ConversationDisplayItem>>(null);
  /**
   * Newest first, because the transcript renders inverted. Offset zero is then
   * the newest message, so opening a conversation lands at the bottom by
   * construction rather than by scrolling there once the rows have measured.
   */
  const displayItems = useMemo(
    () => groupToolActivity(conversation?.items ?? []).reverse(),
    [conversation?.items],
  );
  const activeTool = useMemo(
    () =>
      [...(conversation?.items ?? [])]
        .reverse()
        .find(
          (
            item,
          ): item is Extract<ConversationItem, { kind: 'tool_activity' }> =>
            item.kind === 'tool_activity' && item.state === 'running',
        ),
    [conversation?.items],
  );
  const working = agentStatus === 'working';
  const showWorking = sending || working || activeTool != null;
  const hasOpenRequest = conversation?.activeHumanRequest != null;

  useEffect(() => {
    if (!id) {
      return;
    }
    void herdrRepository
      .loadDraft(id)
      .then(setDraft)
      .catch((error) => {
        console.warn('[CONVERSATION] Could not load draft', error);
      });
  }, [id]);

  useEffect(() => {
    if (!agentId) {
      return;
    }
    const refresh = () => {
      void herdrRepository
        .loadConversation(agentId)
        .then(() => setConversationError(null))
        .catch((error) => {
          console.warn('[CONVERSATION] Could not load conversation', error);
          setConversationError(
            isBridgeUnavailable(error)
              ? 'Not connected to this agent’s device.'
              : toUserMessage(error),
          );
        });
    };
    refresh();
    /**
     * Blocked is polled as well as working, but only until the question turns
     * up. Blocked is Herdr noticing the pane is waiting on someone, which is
     * when a question is being written into the session log — and it arrives a
     * moment after the status does, so the single refresh on the status change
     * usually lands too early and the question never appears until the screen
     * is left and reopened.
     *
     * Once it has arrived there is nothing left to wait for: blocked means
     * waiting on a person, so it can last hours, and polling a phone put down
     * on an open question would never stop.
     */
    const awaitingQuestion = agentStatus === 'blocked' && !hasOpenRequest;
    if (agentStatus === 'working' || awaitingQuestion) {
      const interval = agent?.capabilities.streamingConversation ? 1_000 : 2_000;
      const timer = setInterval(refresh, interval);
      return () => clearInterval(timer);
    }
  }, [
    agent?.capabilities.streamingConversation,
    agentId,
    agentStatus,
    hasOpenRequest,
    ownerConnection,
    reloadToken,
  ]);

  useEffect(() => {
    if (!id) {
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
  }, [draft, id]);

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
    if (!text || sending || !agent) {
      return;
    }
    setSending(true);
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
      setDraft('');
      // The one scroll left in this screen, and the only one that is asked
      // for: sending is a statement that you want to watch the reply. On an
      // inverted list offset zero is the newest message, so unlike
      // `scrollToEnd` this cannot land halfway up a list still measuring
      // itself.
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
      setTimeout(() => {
        void herdrRepository.loadConversation(agent.id).catch((error) => {
          console.warn('[CONVERSATION] Could not refresh after send', error);
        });
      }, 500);
    } catch (error) {
      Alert.alert(
        'Could not send',
        error instanceof Error ? error.message : 'The message was not delivered.',
      );
    } finally {
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
        }}
      />
      <BlurBackdropProvider>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}>
        {/* The composer is a sibling of the target, never a child: a BlurView
            nested inside the target it samples crashes the render thread. */}
        <BlurBackdropTarget>
          <AgentHeader agent={agent} />
          {runtime.connection !== 'connected' ? (
            <GlassSurface style={styles.banner}>
              <ThemedText type="small">Reconnecting</ThemedText>
            </GlassSurface>
          ) : null}
          <ScrollEdgeFrame
            inverted
            // The fade is what stops rows reading through the gaps between the
            // composer's stacked panels, so it has to reach as far as they do.
            bottomHeight={Math.max(ScrollEdgeFade.bottomHeight, composerHeight)}>
            {(onScroll) => (
              <FlatList
                ref={listRef}
                inverted
                data={displayItems}
                keyExtractor={(item) => item.id}
                renderItem={({ item, index }) => (
                  <ConversationRow
                    item={item}
                    agent={agent}
                    onEdit={(text) => setDraft(text)}
                    streaming={index === 0 && showWorking}
                  />
                )}
                onScroll={onScroll}
                scrollEventThrottle={16}
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
                ListHeaderComponent={<View style={{ height: composerHeight }} />}
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
                    ) : (
                      <ActivityIndicator color={Colors.accent} />
                    )}
                  </View>
                }
              />
            )}
          </ScrollEdgeFrame>
        </BlurBackdropTarget>
        <Composer
          value={draft}
          onChangeText={setDraft}
          onSend={() => void send()}
          sending={sending}
          agentId={agent.id}
          request={conversation?.activeHumanRequest ?? null}
          provider={providerLabel(agent.provider)}
          working={showWorking}
          workingLabel={
            activeTool?.title
              ? `${activeTool.title}…`
              : `${providerLabel(agent.provider)} is working`
          }
          agentTitle={agent.title}
          onHeightChange={setComposerHeight}
        />
        </KeyboardAvoidingView>
      </BlurBackdropProvider>
    </Screen>
  );
}

function AgentHeader({ agent }: { agent: RemoteAgent }) {
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
              onPress={() => {
                void herdrRepository.interrupt(agent.id).catch((error) => {
                  Alert.alert(
                    'Could not stop agent',
                    error instanceof Error ? error.message : 'The agent could not be stopped.',
                  );
                });
              }}
              style={({ pressed }) => [styles.stop, { borderColor: theme.border }, pressed && styles.pressed]}>
              <ThemedText type="caption" style={styles.stopText}>Stop</ThemedText>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/**
 * Split out so the reveal hook only ever runs for a message, never for the
 * tool rows and banners that share `ConversationRow`.
 */
function AssistantMessageRow({
  markdown,
  streaming,
}: {
  markdown: string;
  streaming: boolean;
}) {
  const revealed = useRevealedText(markdown, streaming);
  return (
    <View style={styles.assistantMessage}>
      <MarkdownMessage>{revealed}</MarkdownMessage>
    </View>
  );
}

function ConversationRow({
  item,
  agent,
  onEdit,
  streaming = false,
}: {
  item: ConversationDisplayItem;
  agent: RemoteAgent;
  onEdit: (text: string) => void;
  /** Only the newest message, and only while the agent is still writing. */
  streaming?: boolean;
}) {
  const theme = useTheme();

  if (item.kind === 'tool_group') {
    return <ToolActivityGroupRow group={item} />;
  }

  if (item.kind === 'user_message') {
    return (
      <Pressable
        onLongPress={() =>
          Alert.alert('Message', undefined, [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Edit & resend', onPress: () => onEdit(item.text) },
          ])
        }
        style={styles.userWrap}>
        <View
          style={[
            styles.userMessage,
            { backgroundColor: theme.glassStrong, borderColor: theme.glassBorder },
          ]}>
          <ThemedText selectable>{item.text}</ThemedText>
        </View>
      </Pressable>
    );
  }

  if (item.kind === 'assistant_message') {
    return <AssistantMessageRow markdown={item.markdown} streaming={streaming} />;
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
      <ThemedText type="section">{request.question}</ThemedText>
    </View>
  );
}

const MIN_INPUT_HEIGHT = 38;
const MAX_INPUT_HEIGHT = 120;

function Composer({
  value,
  onChangeText,
  onSend,
  sending,
  agentId,
  request,
  provider,
  working,
  workingLabel,
  agentTitle,
  onHeightChange,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  sending: boolean;
  agentId: string;
  request: HumanRequest | null;
  provider: string;
  working: boolean;
  workingLabel: string;
  agentTitle?: string;
  onHeightChange: (height: number) => void;
}) {
  const theme = useTheme();
  const [toolMode, setToolMode] = useState<'Auto' | 'Ask'>('Auto');

  return (
    <View
      style={styles.composer}
      onLayout={(event) => onHeightChange(event.nativeEvent.layout.height)}>
      {request ? (
        // Keyed so a new question starts with a clean slate rather than
        // inheriting the last one's half-made selection.
        <HumanRequestBar key={request.id} agentId={agentId} request={request} />
      ) : null}
      {working ? (
        <View
          style={[
            styles.working,
            { backgroundColor: theme.glassStrong, borderColor: theme.glassBorder },
          ]}>
          <ActivityIndicator size="small" color={theme.accent} />
          <ThemedText type="small" numberOfLines={1} style={styles.workingLabel}>
            {workingLabel}
          </ThemedText>
        </View>
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
              placeholder={request ? 'Write another answer…' : 'Build anything…'}
              placeholderTextColor={theme.placeholder}
              style={[styles.input, { color: theme.text }]}
            />

            <View style={styles.cardBottom}>
              <View style={styles.pillsRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Agent: ${provider}`}
                  onPress={() => {
                    Alert.alert('Agent Provider', `${provider}${agentTitle ? ` • ${agentTitle}` : ''}`);
                  }}
                  style={({ pressed }) => [
                    styles.pill,
                    {
                      backgroundColor: pressed ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.06)',
                      borderColor: theme.glassBorder,
                    },
                  ]}>
                  <ThemedText type="smallBold" style={{ color: theme.text, fontSize: 13 }}>
                    Agent
                  </ThemedText>
                  <AppIcon
                    name={{ ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }}
                    size={14}
                    tintColor={theme.textSecondary}
                    fallback="⌄"
                  />
                </Pressable>

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Execution mode: ${toolMode}`}
                  onPress={() => {
                    Alert.alert('Execution mode', 'Choose how tool calls are approved:', [
                      { text: 'Auto (Approve automatically)', onPress: () => setToolMode('Auto') },
                      { text: 'Ask (Ask for approval)', onPress: () => setToolMode('Ask') },
                      { text: 'Cancel', style: 'cancel' },
                    ]);
                  }}
                  style={({ pressed }) => [
                    styles.pill,
                    {
                      backgroundColor: pressed ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.06)',
                      borderColor: theme.glassBorder,
                    },
                  ]}>
                  <ThemedText type="smallBold" style={{ color: theme.text, fontSize: 13 }}>
                    {toolMode}
                  </ThemedText>
                  <AppIcon
                    name={{ ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }}
                    size={14}
                    tintColor={theme.textSecondary}
                    fallback="⌄"
                  />
                </Pressable>
              </View>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send"
                disabled={!value.trim() || sending}
                onPress={onSend}
                style={({ pressed }) => [
                  styles.send,
                  {
                    backgroundColor: value.trim() && !sending ? theme.accent : 'rgba(255, 255, 255, 0.08)',
                    opacity: pressed ? 0.75 : 1,
                  },
                ]}>
                <BorderBeam radius={18} active={!sending} />
                <AppIcon
                  name={{ ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' }}
                  size={18}
                  tintColor={value.trim() && !sending ? theme.onAccent : theme.textMuted}
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
    paddingHorizontal: Spacing.two + Spacing.half,
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
  banner: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: Spacing.two + Spacing.half,
    marginHorizontal: Spacing.two + Spacing.half,
    marginBottom: Spacing.one,
  },
  messages: {
    flexGrow: 1,
    gap: Spacing.three,
    paddingHorizontal: Spacing.two + Spacing.half,
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
    gap: Spacing.two,
    padding: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.glass,
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
  working: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.pill,
  },
  workingLabel: {
    flex: 1,
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
