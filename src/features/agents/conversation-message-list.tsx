import { useMemo, useState, type Ref } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';

import { MarkdownMessage } from '@/components/markdown/markdown-message';
import { MessageText } from '@/components/markdown/markdown-theme';
import { ThemedText } from '@/components/themed-text';
import { AppIcon } from '@/components/ui/app-icon';
import { ScrollEdgeFrame } from '@/components/ui/scroll-edge-frame';
import { Colors, Radius, ScrollEdgeFade, Spacing } from '@/constants/theme';
import { statusLabel, type ConversationItem, type HumanRequest, type RemoteAgent } from '@/domain/herdr';
import { CommandDelivery } from '@/features/connection/connection-status';
import { useTheme } from '@/hooks/use-theme';
import {
  conversationTranscript,
  type ConversationDisplayItem,
  type TranscriptItem,
} from './conversation-display';
import type { useConversationScroll } from './use-conversation-scroll';

type Props = {
  conversationId?: string;
  data: ConversationDisplayItem[];
  listRef: Ref<FlatList<TranscriptItem>>;
  agent: RemoteAgent;
  onEdit: (text: string) => void;
  connected: boolean;
  error: string | null;
  hasConversation: boolean;
  bottomInset: number;
  topInset?: number;
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
  topInset = 0,
  onRetry,
  scroll,
}: Props) {
  const transcript = useMemo(() => conversationTranscript(data), [data]);
  return (
    <ScrollEdgeFrame
      inverted
      onScroll={(event) => scroll.onScroll(event.nativeEvent.contentOffset.y)}
      // Cover the gaps between all of the composer's stacked panels.
      bottomHeight={Math.max(ScrollEdgeFade.bottomHeight, bottomInset)}>
      {(edge) => (
        <FlatList<TranscriptItem>
          {...edge}
          key={conversationId}
          ref={listRef}
          inverted
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          data={transcript}
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
          ListFooterComponent={<View style={{ height: topInset }} />}
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
  item: TranscriptItem;
  agent: RemoteAgent;
  onEdit: (text: string) => void;
}) {
  const theme = useTheme();

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

  if (item.kind === 'human_request') {
    // Pinned above the composer while it is open, so the transcript carries
    // only the record of one already answered — otherwise the same question
    // would be on screen twice, and the copy that scrolls away is the one
    // without any buttons.
    return item.resolved ? <AskedQuestionRow request={item.request} /> : null;
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
