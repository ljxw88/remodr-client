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
import { AppButton } from '@/components/ui/app-button';
import { AppIcon } from '@/components/ui/app-icon';
import {
  BlurBackdropProvider,
  BlurBackdropTarget,
} from '@/components/ui/blur-backdrop';
import { GlassSurface } from '@/components/ui/glass-surface';
import { Screen } from '@/components/ui/screen';
import { ScrollEdgeFrame } from '@/components/ui/scroll-edge-frame';
import { ThemedText } from '@/components/themed-text';
import { Fonts, Radius, Spacing } from '@/constants/theme';
import {
  providerLabel,
  statusLabel,
  type ConversationItem,
  type HumanRequest,
  type RemoteAgent,
} from '@/domain/herdr';
import { useAgentConversation, useHerdr } from '@/features/agents/use-herdr';
import {
  groupToolActivity,
  toolActivitySummary,
  type ConversationDisplayItem,
  type ToolActivityGroup,
} from '@/features/agents/conversation-display';
import { useTheme } from '@/hooks/use-theme';
import { herdrRepository } from '@/services/herdr-repository';

export default function AgentConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const runtime = useHerdr();
  const agent = runtime.runtime.agents.find((item) => item.id === id);
  const agentId = agent?.id;
  const agentStatus = agent?.status;
  const conversation = useAgentConversation(id ?? '');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<ConversationDisplayItem>>(null);
  const hasFollowedInitialContent = useRef(false);
  const followLatestOnLayout = useRef(true);
  const displayItems = useMemo(
    () => groupToolActivity(conversation?.items ?? []),
    [conversation?.items],
  );
  const latestItemMarker = displayItemMarker(displayItems[displayItems.length - 1]);
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
      void herdrRepository.loadConversation(agentId).catch((error) => {
        console.warn('[CONVERSATION] Could not load conversation', error);
      });
    };
    refresh();
    if (agentStatus === 'working') {
      const interval = agent?.capabilities.streamingConversation ? 1_000 : 2_000;
      const timer = setInterval(refresh, interval);
      return () => clearInterval(timer);
    }
  }, [agent?.capabilities.streamingConversation, agentId, agentStatus]);

  useEffect(() => {
    if (!latestItemMarker) {
      return;
    }
    followLatestOnLayout.current = true;
    const timer = setTimeout(() => {
      listRef.current?.scrollToEnd({
        animated: hasFollowedInitialContent.current,
      });
      hasFollowedInitialContent.current = true;
    }, 50);
    return () => clearTimeout(timer);
  }, [latestItemMarker]);

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
      <Stack.Screen options={{ title: agent.title }} />
      <BlurBackdropProvider>
        <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={88}>
        {/* The composer is a sibling of the target, never a child: a BlurView
            nested inside the target it samples crashes the render thread. */}
        <BlurBackdropTarget>
          <AgentHeader agent={agent} />
          {runtime.connection !== 'connected' ? (
            <GlassSurface style={styles.banner}>
              <ThemedText type="small">Reconnecting</ThemedText>
            </GlassSurface>
          ) : null}
          <ScrollEdgeFrame>
            {(onScroll) => (
              <FlatList
                ref={listRef}
                data={displayItems}
                keyExtractor={(item) => item.id}
                renderItem={({ item }) => (
                  <ConversationRow
                    item={item}
                    agent={agent}
                    onEdit={(text) => setDraft(text)}
                    onTimelineInteraction={() => {
                      followLatestOnLayout.current = false;
                    }}
                  />
                )}
                onScroll={onScroll}
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
                initialNumToRender={20}
                initialScrollIndex={0}
                maxToRenderPerBatch={20}
                windowSize={7}
                contentContainerStyle={styles.messages}
                onLayout={() => {
                  if (followLatestOnLayout.current) {
                    listRef.current?.scrollToEnd({ animated: false });
                  }
                }}
                onContentSizeChange={() => {
                  if (followLatestOnLayout.current) {
                    listRef.current?.scrollToEnd({ animated: false });
                    followLatestOnLayout.current = false;
                    hasFollowedInitialContent.current = true;
                  }
                }}
                ListFooterComponent={
                  <View
                    style={[
                      styles.composerSpacer,
                      showWorking && styles.composerSpacerWorking,
                    ]}
                  />
                }
                ListEmptyComponent={
                  <View style={styles.empty}>
                    <ThemedText type="small" themeColor="textMuted">
                      No conversation yet.
                    </ThemedText>
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
          request={conversation?.activeHumanRequest ?? null}
          provider={providerLabel(agent.provider)}
          working={showWorking}
          workingLabel={
            activeTool?.title
              ? `${activeTool.title}…`
              : `${providerLabel(agent.provider)} is working`
          }
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
        <ThemedText type="caption" themeColor="textSecondary" numberOfLines={1}>
          {agent.cwd ?? agent.workspaceName}
        </ThemedText>
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
          <ThemedText type="smallBold">Stop</ThemedText>
        </Pressable>
      ) : null}
    </View>
  );
}

function ConversationRow({
  item,
  agent,
  onEdit,
  onTimelineInteraction,
}: {
  item: ConversationDisplayItem;
  agent: RemoteAgent;
  onEdit: (text: string) => void;
  onTimelineInteraction: () => void;
}) {
  const theme = useTheme();

  if (item.kind === 'tool_group') {
    return (
      <ToolActivityGroupRow
        group={item}
        onToggle={onTimelineInteraction}
      />
    );
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
    return item.resolved ? null : (
      <HumanRequestCard agentId={agent.id} request={item.request} />
    );
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

function ToolActivityGroupRow({
  group,
  onToggle,
}: {
  group: ToolActivityGroup;
  onToggle: () => void;
}) {
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
        onPress={() => {
          onToggle();
          setExpanded((current) => !current);
        }}
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

function displayItemMarker(item?: ConversationDisplayItem): string {
  if (!item) {
    return '';
  }
  if (item.kind === 'assistant_message') {
    return `${item.id}:${item.markdown.length}`;
  }
  if (item.kind === 'user_message' || item.kind === 'raw_output') {
    return `${item.id}:${item.text.length}`;
  }
  if (item.kind === 'tool_group') {
    const latest = item.items[item.items.length - 1];
    return `${item.id}:${item.items.length}:${latest?.state ?? ''}`;
  }
  if (item.kind === 'tool_activity') {
    return `${item.id}:${item.state}`;
  }
  return item.id;
}

function HumanRequestCard({ agentId, request }: { agentId: string; request: HumanRequest }) {
  const theme = useTheme();
  const [selected, setSelected] = useState<string[]>([]);

  async function answer(optionId?: string) {
    try {
      const selectedOptionIds = optionId ? [optionId] : selected;
      await herdrRepository.answerHumanRequest(agentId, request.id, { selectedOptionIds });
      await herdrRepository.loadConversation(agentId);
    } catch (error) {
      Alert.alert(
        'Could not answer',
        error instanceof Error ? error.message : 'The answer could not be sent.',
      );
    }
  }

  return (
    <View style={[styles.request, { backgroundColor: theme.glassStrong, borderColor: theme.glassBorder }]}>
      <ThemedText type="label" themeColor="textMuted">
        NEEDS YOUR INPUT
      </ThemedText>
      <ThemedText type="section">{request.question}</ThemedText>
      {request.options.map((option) => {
        const isSelected = selected.includes(option.id);
        return (
          <Pressable
            key={option.id}
            accessibilityRole="button"
            accessibilityState={{ selected: isSelected }}
            onPress={() => {
              if (!request.multiSelect) {
                void answer(option.id);
                return;
              }
              setSelected((current) =>
                isSelected
                  ? current.filter((item) => item !== option.id)
                  : [...current, option.id],
              );
            }}
            style={({ pressed }) => [
              styles.option,
              {
                backgroundColor: isSelected ? theme.accentSoft : theme.backgroundElement,
                borderColor: isSelected ? theme.accent : theme.border,
                opacity: pressed ? 0.72 : 1,
              },
            ]}>
            <ThemedText
              type="smallBold"
              style={{ color: isSelected ? theme.accent : theme.text }}>
              {option.label}
            </ThemedText>
            {option.description ? (
              <ThemedText type="caption" themeColor="textSecondary">
                {option.description}
              </ThemedText>
            ) : null}
          </Pressable>
        );
      })}
      {request.multiSelect ? (
        <AppButton
          label="Submit"
          onPress={() => void answer()}
          disabled={selected.length === 0}
        />
      ) : null}
    </View>
  );
}

function Composer({
  value,
  onChangeText,
  onSend,
  sending,
  request,
  provider,
  working,
  workingLabel,
}: {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  sending: boolean;
  request: HumanRequest | null;
  provider: string;
  working: boolean;
  workingLabel: string;
}) {
  const theme = useTheme();
  return (
    <View style={styles.composer}>
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
      <GlassSurface tone="chrome" strength="strong" style={styles.inputFrame}>
        <TextInput
          accessibilityLabel={request ? 'Write an answer' : `Message ${provider}`}
          multiline
          maxLength={20_000}
          value={value}
          onChangeText={onChangeText}
          placeholder={request ? 'Write another answer…' : `Message ${provider}…`}
          placeholderTextColor={theme.placeholder}
          style={[styles.input, { color: theme.text }]}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send"
          disabled={!value.trim() || sending}
          onPress={onSend}
          style={({ pressed }) => [
            styles.send,
            {
              backgroundColor: theme.accent,
              opacity: !value.trim() || sending ? 0.4 : pressed ? 0.75 : 1,
            },
          ]}>
          <AppIcon
            name={{ ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' }}
            size={18}
            tintColor={theme.onAccent}
            fallback="↑"
          />
        </Pressable>
      </GlassSurface>
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
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two + Spacing.half,
    borderBottomWidth: 0,
  },
  contextCopy: {
    flex: 1,
    gap: 3,
  },
  statusLine: {
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
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.pill,
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
  option: {
    gap: 3,
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
    paddingBottom: Spacing.one,
    gap: Spacing.one,
  },
  composerSpacer: {
    height: 104,
  },
  composerSpacerWorking: {
    height: 148,
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
  inputFrame: {
    minHeight: 56,
    maxHeight: 160,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.one,
    paddingLeft: Spacing.two,
    paddingRight: 6,
    paddingVertical: 6,
    elevation: 8,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.18,
    shadowRadius: 24,
  },
  input: {
    flex: 1,
    minHeight: 38,
    maxHeight: 140,
    paddingTop: 8,
    paddingBottom: 8,
    fontFamily: Fonts.regular,
    fontSize: 16,
    lineHeight: 22,
  },
  send: {
    width: 42,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.pill,
  },
  empty: {
    alignItems: 'center',
    paddingVertical: Spacing.four,
  },
  pressed: {
    opacity: 0.6,
  },
});
