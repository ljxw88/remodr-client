import { useState, type Ref } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { MarkdownMessage } from '@/components/markdown/markdown-message';
import { MessageText } from '@/components/markdown/markdown-theme';
import { ThemedText } from '@/components/themed-text';
import { AppIcon, type AppIconName } from '@/components/ui/app-icon';
import { ScrollEdgeFrame } from '@/components/ui/scroll-edge-frame';
import { Colors, Radius, ScrollEdgeFade, Spacing } from '@/constants/theme';
import { statusLabel, type ConversationItem, type HumanRequest, type RemoteAgent } from '@/domain/herdr';
import { CommandDelivery } from '@/features/connection/connection-status';
import { useTheme } from '@/hooks/use-theme';
import {
  planProgress,
  toolActivitySummary,
  type ConversationDisplayItem,
  type PlanItem,
  type ToolActivityGroup,
} from './conversation-display';
import type { useConversationScroll } from './use-conversation-scroll';

type Props = {
  conversationId?: string;
  data: ConversationDisplayItem[];
  listRef: Ref<FlatList<ConversationDisplayItem>>;
  agent: RemoteAgent;
  onEdit: (text: string) => void;
  connected: boolean;
  error: string | null;
  hasConversation: boolean;
  bottomInset: number;
  onRetry: () => void;
  scroll: Pick<ReturnType<typeof useConversationScroll>,
    'schedule' | 'onScroll' | 'onScrollBeginDrag' | 'onScrollEndDrag' |
    'onMomentumScrollBegin' | 'onMomentumScrollEnd'>;
};

const HISTORY_ANCHOR = { minIndexForVisible: 0 };

export function ConversationMessageList({
  conversationId,
  data,
  listRef,
  agent,
  onEdit,
  connected,
  error,
  hasConversation,
  bottomInset,
  onRetry,
  scroll,
}: Props) {
  return (
    <ScrollEdgeFrame
      inverted
      onScroll={(event) => scroll.onScroll(event.nativeEvent.contentOffset.y)}
      // Cover the gaps between all of the composer's stacked panels.
      bottomHeight={Math.max(ScrollEdgeFade.bottomHeight, bottomInset)}>
      {(edge) => (
        <FlatList
          {...edge}
          key={conversationId}
          ref={listRef}
          inverted
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          data={data}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <ConversationRow item={item} agent={agent} onEdit={onEdit} />
          )}
          showsVerticalScrollIndicator={false}
          initialNumToRender={20}
          maxToRenderPerBatch={20}
          windowSize={7}
          contentContainerStyle={styles.messages}
          onContentSizeChange={(width, height) => {
            edge.onContentSizeChange(width, height);
            scroll.schedule();
          }}
          onLayout={(event) => {
            edge.onLayout(event);
            scroll.schedule();
          }}
          onScrollBeginDrag={(event) => scroll.onScrollBeginDrag(event.nativeEvent.contentOffset.y)}
          onScrollEndDrag={(event) => scroll.onScrollEndDrag(event.nativeEvent.contentOffset.y)}
          onMomentumScrollBegin={scroll.onMomentumScrollBegin}
          onMomentumScrollEnd={(event) => scroll.onMomentumScrollEnd(event.nativeEvent.contentOffset.y)}
          // Keep native anchoring stable: toggling it can reuse a stale
          // anchor on iOS. Explicit follow runs after layout settles.
          maintainVisibleContentPosition={HISTORY_ANCHOR}
          // Inverted, so this measured spacer sits below the newest message.
          ListHeaderComponent={<View style={{ height: bottomInset }} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              {error ? (
                <>
                  <ThemedText type="small" themeColor="textMuted">
                    {error}
                  </ThemedText>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Retry loading conversation"
                    onPress={onRetry}>
                    <ThemedText type="smallBold" style={styles.retry}>
                      Try again
                    </ThemedText>
                  </Pressable>
                </>
              ) : hasConversation ? (
                <ThemedText type="small" themeColor="textMuted">
                  No conversation yet.
                </ThemedText>
              ) : connected ? (
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
          previousSession={item.previousSession}
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
    return <PlanRow todos={item.todos} />;
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

/**
 * One tool call, and deliberately not a thing you can open.
 *
 * The group above it is already a disclosure; making each call inside it
 * another one puts three layers between the reader and a detail — collapsed
 * group, open group, open call — and by the third nobody knows where they are.
 * So the detail is simply here, and the group is the only thing that folds.
 */
function ToolActivityRow({
  item,
}: {
  item: Extract<ConversationItem, { kind: 'tool_activity' }>;
}) {
  const theme = useTheme();
  const tone = toolStateTone(item.state, theme);
  const label = toolStateLabel(item.state);

  return (
    <View style={styles.toolCall}>
      <View style={styles.toolCallMark}>
        {item.state === 'running' ? (
          <ActivityIndicator size="small" color={theme.accent} />
        ) : (
          <AppIcon
            name={toolStateIcon(item.state)}
            size={14}
            tintColor={tone}
            fallback={item.state === 'failed' || item.state === 'cancelled' ? '✕' : '·'}
          />
        )}
      </View>
      <View style={styles.toolCopy}>
        <ThemedText type="smallBold">{item.title}</ThemedText>
        {item.detail ? (
          <ThemedText type="caption" themeColor="textSecondary">
            {item.detail}
          </ThemedText>
        ) : null}
      </View>
      {/* Only when it says something. "Done" on every completed call is a
          column of the word "Done", which is not a status, it is wallpaper. */}
      {label ? (
        <ThemedText type="caption" style={{ color: tone }}>
          {label}
        </ThemedText>
      ) : null}
    </View>
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
  const { label, failed, running } = toolActivitySummary(group);
  const failedLabel = failed > 0 ? `${failed} failed` : null;

  return (
    <Pressable
      accessibilityRole="button"
      /* The count is in the visible label already; what a screen reader is
         missing is what the row does and what the colour is saying. */
      accessibilityLabel={[
        label,
        failedLabel,
        expanded ? 'Collapse tool calls' : 'Expand tool calls',
      ].filter(Boolean).join('. ')}
      accessibilityState={{ expanded }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.toolSummary,
        pressed && styles.pressed,
      ]}>
      <View style={styles.toolCallMark}>
        {running ? (
          <ActivityIndicator size="small" color={theme.accent} />
        ) : (
          <AppIcon
            name={{ ios: 'hammer', android: 'build', web: 'build' }}
            size={16}
            tintColor={theme.textMuted}
            fallback="•"
          />
        )}
      </View>
      <ThemedText type="smallBold" style={styles.toolSummaryLabel}>
        {label}
      </ThemedText>
      {/* A failure inside a folded group is the one thing that must not need
          opening to be seen. Six calls that worked and one that did not is not
          "worked for 20m". */}
      {failedLabel ? (
        <ThemedText type="caption" style={{ color: theme.danger }}>
          {failedLabel}
        </ThemedText>
      ) : null}
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

/**
 * The agent's plan, as one live checklist.
 *
 * Every state the bridge can send is drawn differently, which sounds obvious
 * and was not true: `in_progress` and `blocked` used to render exactly like
 * `pending`, so the two things a reader actually wants — where the agent is
 * now, and what is stuck — were the two things the plan would not tell them.
 *
 * Finished steps are dimmed rather than hidden. They are worth keeping as a
 * record of where the work has been, and worth taking the eye off, so what is
 * left carries the weight.
 */
function PlanRow({ todos }: { todos: PlanItem[] }) {
  const theme = useTheme();
  const { done, total } = planProgress(todos);

  return (
    <View
      style={[styles.plan, { backgroundColor: theme.glass, borderColor: theme.glassBorder }]}>
      <View style={styles.planHeader}>
        <ThemedText type="smallBold">Plan</ThemedText>
        <ThemedText type="caption" themeColor="textMuted">
          {done} of {total}
        </ThemedText>
      </View>
      {todos.map((todo, index) => (
        <PlanStep key={todo.id ?? `${index}:${todo.text}`} todo={todo} />
      ))}
    </View>
  );
}

function PlanStep({ todo }: { todo: PlanItem }) {
  const theme = useTheme();
  const active = todo.state === 'in_progress';
  const finished = todo.state === 'done';
  const blocked = todo.state === 'blocked';

  return (
    <View
      accessible
      accessibilityLabel={`${todo.text}, ${todo.state.replace('_', ' ')}`}
      style={styles.planStep}>
      <View style={styles.planStepMark}>
        {active ? (
          <ActivityIndicator size="small" color={theme.accent} />
        ) : (
          <AppIcon
            name={planStateIcon(todo.state)}
            size={14}
            tintColor={
              finished ? theme.textMuted : blocked ? theme.warning : theme.textMuted
            }
            fallback={finished ? '✓' : blocked ? '!' : '○'}
          />
        )}
      </View>
      <ThemedText
        type="caption"
        style={[
          styles.planStepText,
          {
            color: active
              ? theme.accent
              : blocked
                ? theme.warning
                : finished
                  ? theme.textMuted
                  : theme.textSecondary,
          },
        ]}>
        {todo.text}
      </ThemedText>
    </View>
  );
}

function planStateIcon(state: PlanItem['state']): AppIconName {
  if (state === 'done') {
    return { ios: 'checkmark', android: 'check', web: 'check' };
  }
  if (state === 'blocked') {
    return { ios: 'exclamationmark.circle.fill', android: 'error', web: 'error' };
  }
  return { ios: 'circle', android: 'radio_button_unchecked', web: 'radio_button_unchecked' };
}

function toolStateIcon(
  state: Extract<ConversationItem, { kind: 'tool_activity' }>['state'],
): AppIconName {
  if (state === 'completed') {
    return { ios: 'checkmark', android: 'check', web: 'check' };
  }
  if (state === 'failed' || state === 'cancelled') {
    return { ios: 'xmark', android: 'close', web: 'close' };
  }
  return { ios: 'circle', android: 'radio_button_unchecked', web: 'radio_button_unchecked' };
}

/**
 * A completed call is dimmed rather than green. Six green ticks in a row say
 * nothing a reader did not already assume, and they leave nothing for the one
 * red cross among them to stand out against.
 */
function toolStateTone(
  state: Extract<ConversationItem, { kind: 'tool_activity' }>['state'],
  theme: typeof Colors,
): string {
  if (state === 'failed') return theme.danger;
  if (state === 'running') return theme.accent;
  return theme.textMuted;
}

function toolStateLabel(
  state: Extract<ConversationItem, { kind: 'tool_activity' }>['state'],
) {
  switch (state) {
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

const styles = StyleSheet.create({
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
  /** One call inside an opened group. */
  toolCall: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.one,
    paddingHorizontal: Spacing.one,
    paddingVertical: Spacing.half + 2,
  },
  /**
   * A fixed column for the state mark, so a spinner and a glyph of different
   * sizes leave the titles beside them on one line.
   */
  toolCallMark: {
    width: 18,
    minHeight: 20,
    alignItems: 'center',
    justifyContent: 'center',
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
    gap: Spacing.half,
    padding: Spacing.one + Spacing.half,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderRadius: Radius.control,
  },
  planHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.one,
    paddingBottom: Spacing.half,
  },
  planStep: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.one,
  },
  planStepMark: {
    width: 18,
    minHeight: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  planStepText: {
    flex: 1,
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
