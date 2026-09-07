import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Modal, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { menuPosition } from '@/components/ui/action-menu';
import { AppIcon } from '@/components/ui/app-icon';
import { Radius, Spacing } from '@/constants/theme';
import type { ConversationItem } from '@/domain/herdr';
import { useTheme } from '@/hooks/use-theme';
import { PlanRow, ToolActivityRow } from './conversation-activity-rows';
import { conversationActivity, planProgress, type PlanItem, type ToolActivityItem } from './conversation-display';

type Anchor = { x: number; y: number; width: number; height: number };

type Props = {
  items: ConversationItem[];
  sessionKey: string;
  active: boolean;
  keyboardInset: number;
};

/** A top-anchored native popup leaves the transcript and composer geometry intact. */
export function ConversationActivityPanel({ items, sessionKey, active, keyboardInset }: Props) {
  const dimensions = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { tools, todos } = useMemo(() => conversationActivity(items), [items]);
  if (tools.length === 0 && todos.length === 0) return null;

  return (
    <ActivityPopup
      key={JSON.stringify([sessionKey, active, dimensions.width, dimensions.height, dimensions.fontScale, keyboardInset, insets.top, insets.bottom])}
      tools={tools}
      todos={todos}
      active={active}
      keyboardInset={keyboardInset}
      dimensions={dimensions}
      insets={insets}
    />
  );
}

function ActivityPopup({ tools, todos, active, keyboardInset, dimensions, insets }: {
  tools: ToolActivityItem[];
  todos: PlanItem[];
  active: boolean;
  keyboardInset: number;
  dimensions: ReturnType<typeof useWindowDimensions>;
  insets: ReturnType<typeof useSafeAreaInsets>;
}) {
  const theme = useTheme();
  const trigger = useRef<View | null>(null);
  const generation = useRef(0);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const { done, total } = planProgress(todos);
  const failed = tools.filter((tool) => tool.state === 'failed').length;
  const running = tools.filter((tool) => tool.state === 'running').length;
  const pending = tools.filter((tool) => tool.state === 'pending').length;
  const open = anchor != null && active;
  const invalidateMeasurement = useCallback(() => {
    generation.current++;
  }, []);
  function close() {
    invalidateMeasurement();
    setAnchor(null);
  }

  // The keyed popup resets on session/visibility/viewport changes. Late native
  // measurements from an unmounted popup must not restore its open state.
  useLayoutEffect(() => invalidateMeasurement, [invalidateMeasurement]);

  const summary = [
    tools.length > 0 ? `${tools.length} tool ${tools.length === 1 ? 'call' : 'calls'}` : null,
    failed > 0 ? `${failed} failed` : null,
    running > 0 ? `${running} running` : null,
    pending > 0 ? `${pending} pending` : null,
    total > 0 ? `Plan ${done} of ${total}` : null,
  ].filter(Boolean).join(' · ');
  const width = Math.max(0, Math.min(anchor?.width ?? dimensions.width, dimensions.width - Spacing.four));
  const position = anchor ? menuPosition(anchor, { width, height: 0 }, {
    ...dimensions, top: insets.top, bottom: Math.max(insets.bottom, keyboardInset),
  }) : { left: 0, top: 0 };
  const maxHeight = Math.max(0, Math.min(
    (dimensions.height - insets.top - Math.max(insets.bottom, keyboardInset)) * 0.4,
    dimensions.height - Math.max(insets.bottom, keyboardInset) - position.top - Spacing.two,
  ));

  function show() {
    if (!active) return;
    const token = ++generation.current;
    trigger.current?.measureInWindow((x, y, measuredWidth, measuredHeight) => {
      if (token !== generation.current || measuredWidth <= 0 || measuredHeight <= 0) return;
      setAnchor({ x, y, width: measuredWidth, height: measuredHeight });
    });
  }

  function toggle(expanded: boolean) {
    return (
      <Pressable
        ref={expanded ? undefined : trigger}
        testID={expanded ? 'activity-close' : 'activity-trigger'}
        accessibilityRole="button"
        accessibilityLabel={`Plan & tools. ${summary}. ${open ? 'Collapse' : 'Expand'} activity`}
        accessibilityState={{ expanded: open }}
        onPress={open ? close : show}
        onLayout={expanded ? undefined : close}
        style={({ pressed }) => [
          styles.trigger, { backgroundColor: theme.background, borderColor: theme.glassBorder },
          pressed && styles.pressed,
        ]}>
        <View style={styles.copy}>
          <ThemedText type="smallBold">Plan &amp; tools</ThemedText>
          <ThemedText type="caption" numberOfLines={2} style={{ color: failed ? theme.danger : theme.textMuted }}>
            {summary}
          </ThemedText>
        </View>
        <AppIcon
          name={{
            ios: open ? 'chevron.up' : 'chevron.down',
            android: open ? 'expand_less' : 'expand_more',
            web: open ? 'expand_less' : 'expand_more',
          }}
          size={16}
          tintColor={theme.textMuted}
          fallback={open ? '⌃' : '⌄'}
        />
      </Pressable>
    );
  }

  return (
    <View style={styles.container}>
      {toggle(false)}
      {open ? (
        <Modal transparent animationType="none" statusBarTranslucent onRequestClose={close}>
          <View style={styles.overlay}>
            <Pressable
              testID="activity-backdrop"
              style={StyleSheet.absoluteFill}
              onPress={close}
              accessible={false}
              importantForAccessibility="no"
            />
            <View
              style={StyleSheet.absoluteFill}
              pointerEvents="box-none"
              accessibilityViewIsModal
              accessibilityLabel="Plan & tools"
              onAccessibilityEscape={close}>
              {/* The modal intercepts touches, so repeat the same trigger at its
                  measured position to keep tap-to-collapse available. */}
              <View style={{ position: 'absolute', left: anchor.x, top: anchor.y, width: anchor.width }}>
                {toggle(true)}
              </View>
              <View
                testID="activity-popup"
                style={[styles.popup, position, { width, maxHeight, backgroundColor: theme.background, borderColor: theme.glassBorder }]}>
                <FlatList
                  testID="activity-list"
                  data={tools}
                  keyExtractor={(item) => item.id}
                  renderItem={({ item }) => <ToolActivityRow item={item} />}
                  ListHeaderComponent={
                    <View style={styles.sections}>
                      {total > 0 ? <PlanRow todos={todos} /> : null}
                      {tools.length > 0 ? <ThemedText type="smallBold">Tools · newest first</ThemedText> : null}
                    </View>
                  }
                  style={styles.list}
                  contentContainerStyle={styles.content}
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled
                  initialNumToRender={12}
                />
              </View>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginHorizontal: Spacing.two, marginVertical: Spacing.half },
  trigger: {
    minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: Spacing.one,
    paddingHorizontal: Spacing.one + Spacing.half, paddingVertical: Spacing.one,
    borderRadius: Radius.control, borderWidth: StyleSheet.hairlineWidth,
  },
  copy: { flex: 1, gap: 2 },
  overlay: { flex: 1 },
  popup: {
    position: 'absolute', borderRadius: Radius.control, borderWidth: 1,
    overflow: 'hidden', boxShadow: '0 8px 24px rgba(0, 0, 0, 0.2)',
  },
  list: { flexGrow: 0 },
  content: { padding: Spacing.one },
  sections: { gap: Spacing.one, marginBottom: Spacing.half },
  pressed: { opacity: 0.6 },
});
