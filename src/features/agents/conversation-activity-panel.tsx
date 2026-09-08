import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Animated, BackHandler, FlatList, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { AppIcon } from '@/components/ui/app-icon';
import { GlassSurface } from '@/components/ui/glass-surface';
import { ChipGeometry, ControlHeight, Radius, Spacing } from '@/constants/theme';
import type { ConversationItem } from '@/domain/herdr';
import { useTheme } from '@/hooks/use-theme';
import { useDisclosureMotion } from '@/hooks/use-disclosure-motion';
import { PlanStep, ToolActivityRow } from './conversation-activity-rows';
import { ActivityLayout } from './conversation-activity-layout';
import { conversationActivity, planProgress, type PlanItem, type ToolActivityItem } from './conversation-display';

type Props = {
  items: ConversationItem[];
  sessionKey: string;
  active: boolean;
  keyboardInset: number;
  onHeightChange?: (height: number) => void;
};
type Section = 'plan' | 'tools';
type Row = { id: string; kind: 'plan'; todo: PlanItem } | { id: string; kind: 'tool'; tool: ToolActivityItem };

// Inversion opens at the newest/bottom content without a delayed scroll or flash.
const BOTTOM_ANCHOR = { minIndexForVisible: 0, autoscrollToTopThreshold: 24 };
const SURFACE_TOP_INSET = Spacing.half + 2;
const COLLAPSED_HEIGHT = Math.max(ControlHeight.regular, SURFACE_TOP_INSET + ChipGeometry.minHeight);

export function ConversationActivityPanel({ items, sessionKey, active, keyboardInset, onHeightChange }: Props) {
  const dimensions = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { tools, todos } = useMemo(() => conversationActivity(items), [items]);
  if (tools.length === 0 && todos.length === 0) return null;
  return (
    <ActivitySection
      key={JSON.stringify([sessionKey, active, dimensions.width, dimensions.height, keyboardInset])}
      tools={tools}
      todos={todos}
      active={active}
      onHeightChange={onHeightChange}
      panelHeight={Math.max(0, Math.min(260,
        (dimensions.height - insets.top - Math.max(insets.bottom, keyboardInset)) * 0.32))}
    />
  );
}

function ActivitySection({ tools, todos, active, panelHeight, onHeightChange }: {
  tools: ToolActivityItem[];
  todos: PlanItem[];
  active: boolean;
  panelHeight: number;
  onHeightChange?: (height: number) => void;
}) {
  const theme = useTheme();
  const [selected, setSelected] = useState<Section | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [headingHeight, setHeadingHeight] = useState(ActivityLayout.headingMinHeight);
  const available = active && (selected === 'plan' ? todos.length > 0 : selected === 'tools' && tools.length > 0)
    ? selected : null;
  if (selected && !available) {
    setSelected(null);
    setExpanded(false);
  }
  const open = expanded && available != null;
  const motion = useDisclosureMotion(open, active && available != null);
  const visible = motion.present ? available : null;
  const headerExtent = headingHeight + ActivityLayout.borderWidth * 2;
  const bodyHeight = Math.max(0, panelHeight - headerExtent - Spacing.one);
  const { done, total } = planProgress(todos);
  const failed = tools.filter((tool) => tool.state === 'failed').length;
  const running = tools.some((tool) => tool.state === 'running' || tool.state === 'pending');
  const rows = useMemo<Row[]>(() => visible === 'plan'
    ? todos.map((todo, index) => ({ id: todo.id ?? `${index}:${todo.text}`, kind: 'plan' as const, todo })).reverse()
    : tools.map((tool) => ({ id: tool.id, kind: 'tool' as const, tool })), [visible, todos, tools]);

  useLayoutEffect(() => {
    // Retire the previous panel's clearance before a reset can paint it behind
    // collapsed chips. Native layout still supplies font-scaled measurements.
    onHeightChange?.((visible ? panelHeight + SURFACE_TOP_INSET : COLLAPSED_HEIGHT) + Spacing.one);
    return () => onHeightChange?.(0);
  }, [onHeightChange, panelHeight, visible]);

  useEffect(() => {
    if (!open) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setExpanded(false);
      return true;
    });
    return () => subscription.remove();
  }, [open]);

  function labelRow(section: Section, label: string, detail: string, panel = false) {
    const chevronIcon = (
      <AppIcon
        name={{ ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }}
        size={ActivityLayout.iconSize} tintColor={theme.textMuted} fallback="⌄"
      />
    );
    const chevron = panel ? (
      <Animated.View testID="activity-disclosure-chevron" style={[styles.chevron, { transform: [{
        rotate: motion.progress.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] }),
      }] }]}>{chevronIcon}</Animated.View>
    ) : chevronIcon;
    const icon = (
      <AppIcon
        name={section === 'plan'
          ? { ios: 'checklist', android: 'checklist', web: 'checklist' }
          : { ios: 'wrench', android: 'build', web: 'build' }}
        size={ActivityLayout.iconSize}
        tintColor={section === 'tools' && running ? theme.accent : theme.textSecondary}
        fallback={section === 'plan' ? '✓' : '·'}
      />
    );
    const failure = section === 'tools' && failed > 0
      ? <View testID="activity-failure-dot" style={[styles.dot, { backgroundColor: theme.danger }]} />
      : null;
    if (panel) {
      return (
        <View testID={`activity-${section}-heading`} style={styles.labelRow}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants">
          <View testID="activity-heading-leading" style={styles.headingSide}>{chevron}{icon}</View>
          <ThemedText testID="activity-label" type="caption" style={styles.centeredTitle} numberOfLines={1}>
            {label}
          </ThemedText>
          <View testID="activity-heading-trailing" style={[styles.headingSide, styles.headingTrailing]}>
            <ThemedText type="caption" themeColor="textMuted" style={styles.detail} numberOfLines={1}>{detail}</ThemedText>
            {failure}
          </View>
        </View>
      );
    }
    return (
      <View testID={`activity-${section}-content`} style={[styles.labelRow, styles.chipContent]}>
        {chevron}
        {icon}
        <ThemedText testID="activity-label" type="caption">{label}</ThemedText>
        <ThemedText type="caption" themeColor="textMuted" style={styles.detail}>{detail}</ThemedText>
        {failure}
      </View>
    );
  }

  function chip(section: Section, label: string, detail: string) {
    return (
      <Pressable
        testID={`activity-${section}-chip`}
        accessibilityRole="button"
        accessibilityLabel={`Show ${label.toLowerCase()}`}
        accessibilityHint={section === 'plan' ? `${done} of ${total} steps complete` :
          `${tools.length} tool calls${failed ? `, ${failed} failed` : ''}. Opens at latest activity.`}
        accessibilityState={{ expanded: false, disabled: !active }}
        disabled={!active}
        onPress={() => { setSelected(section); setExpanded(true); }}
        style={({ pressed }) => [styles.chipTarget, { opacity: pressed ? 0.72 : active ? 1 : 0.5 }]}>
        <View testID={`activity-${section}-shadow`} style={styles.chipShadow}>
          <GlassSurface tone="chrome" style={styles.chip}>
            {labelRow(section, label, detail)}
          </GlassSurface>
        </View>
      </Pressable>
    );
  }

  return (
    <View testID="activity-section" pointerEvents="box-none"
      style={[styles.section, visible && { height: panelHeight + SURFACE_TOP_INSET }]}
      onLayout={(event) => {
        if (!visible) onHeightChange?.(event.nativeEvent.layout.height + Spacing.one);
      }}>
      {visible ? (
        <Animated.View testID="activity-panel-shadow" style={[styles.panelShadow, {
          height: motion.progress.interpolate({
            inputRange: [0, 1], outputRange: [Math.min(headerExtent, panelHeight), panelHeight], extrapolate: 'clamp',
          }),
        }]}>
        <GlassSurface
          testID="activity-panel"
          tone="chrome"
          strength="strong"
          style={styles.panel}
          accessible={false}
          onAccessibilityEscape={() => setExpanded(false)}>
          <View testID="activity-heading" onLayout={(event) => setHeadingHeight(event.nativeEvent.layout.height)}>
            <Pressable
              testID="activity-collapse"
              accessibilityRole="button"
              accessibilityLabel={open ? `Collapse ${visible === 'plan' ? 'plan' : 'tool use'}` : `Show ${visible}`}
              accessibilityHint={visible === 'plan' ? `${done} of ${total} steps complete` : `${tools.length} tool calls`}
              accessibilityState={{ expanded: open }}
              onPress={() => setExpanded((value) => !value)}
              style={({ pressed }) => ({ opacity: pressed ? 0.72 : 1 })}>
              {labelRow(visible, visible === 'plan' ? 'Plan' : 'Tools',
                visible === 'plan' ? `${done}/${total}` : String(tools.length), true)}
            </Pressable>
          </View>
          <View testID="activity-viewport" style={styles.viewport}
            pointerEvents={open ? 'auto' : 'none'} accessibilityElementsHidden={!open}
            importantForAccessibility={open ? 'auto' : 'no-hide-descendants'}>
          <View testID="activity-fixed-viewport" style={[styles.fixedViewport, { height: bodyHeight }]}>
          <FlatList<Row>
            key={visible}
            testID="activity-content"
            inverted
            data={rows}
            keyExtractor={(row) => row.id}
            renderItem={({ item }) => item.kind === 'plan'
              ? <PlanStep todo={item.todo} />
              : <ToolActivityRow item={item.tool} />}
            maintainVisibleContentPosition={BOTTOM_ANCHOR}
            initialNumToRender={12}
            windowSize={5}
            removeClippedSubviews={false}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            style={styles.list}
            contentContainerStyle={[styles.content, visible === 'tools' && styles.toolSpacing]}
          />
          </View>
          </View>
          <Animated.View pointerEvents="none" testID="activity-bottom-space" style={{
            height: motion.progress.interpolate({ inputRange: [0, 1], outputRange: [0, Spacing.one] }),
          }} />
        </GlassSurface>
        </Animated.View>
      ) : (
        <ScrollView
          testID="activity-strip"
          horizontal
          style={styles.strip}
          removeClippedSubviews={false}
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.chips}>
          {todos.length > 0 ? chip('plan', 'Plan', `${done}/${total}`) : null}
          {tools.length > 0 ? chip('tools', 'Tools', String(tools.length)) : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    position: 'absolute',
    top: Spacing.half,
    left: Spacing.two,
    right: Spacing.two,
    backgroundColor: 'transparent',
  },
  strip: { alignSelf: 'flex-start', maxWidth: '100%', backgroundColor: 'transparent', overflow: 'visible' },
  chips: { alignItems: 'center', gap: Spacing.one },
  chipTarget: { minHeight: COLLAPSED_HEIGHT, paddingTop: SURFACE_TOP_INSET, justifyContent: 'flex-start' },
  chip: {
    minHeight: ChipGeometry.minHeight,
    borderRadius: Radius.pill, borderWidth: ActivityLayout.borderWidth, padding: 0,
  },
  labelRow: {
    minHeight: ActivityLayout.headingMinHeight, paddingHorizontal: ChipGeometry.paddingHorizontal,
    flexDirection: 'row', alignItems: 'center',
  },
  chipContent: { gap: ChipGeometry.gap },
  chipShadow: { borderRadius: Radius.pill, boxShadow: '0 3px 10px rgba(0, 0, 0, 0.18)' },
  panelShadow: {
    marginTop: SURFACE_TOP_INSET,
    borderRadius: Radius.control,
    boxShadow: '0 5px 16px rgba(0, 0, 0, 0.18)',
    overflow: 'hidden',
  },
  dot: { width: 5, height: 5, borderRadius: 3 },
  panel: { flex: 1, borderRadius: Radius.control, borderWidth: ActivityLayout.borderWidth, padding: 0 },
  chevron: { width: ActivityLayout.iconSize, height: ActivityLayout.iconSize, alignItems: 'center', justifyContent: 'center' },
  headingSide: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: ChipGeometry.gap },
  headingTrailing: { justifyContent: 'flex-end' },
  centeredTitle: { flexShrink: 1, marginHorizontal: ChipGeometry.gap, textAlign: 'center' },
  detail: { flexShrink: 1, fontVariant: ['tabular-nums'] },
  viewport: { flex: 1, overflow: 'hidden' },
  fixedViewport: { position: 'absolute', bottom: 0, left: 0, right: 0 },
  list: { flex: 1 },
  content: { paddingHorizontal: ChipGeometry.paddingHorizontal, paddingVertical: 0, gap: Spacing.half },
  toolSpacing: { gap: Spacing.one },
});
