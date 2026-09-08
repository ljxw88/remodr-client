import { createElement, type ComponentProps } from 'react';
import TestRenderer from 'react-test-renderer';
import { ActivityIndicator, Animated, BackHandler, FlatList, Modal, ScrollView, StyleSheet } from 'react-native';

import { GlassSurface } from '@/components/ui/glass-surface';
import { AppIcon } from '@/components/ui/app-icon';
import { ThemedText } from '@/components/themed-text';
import type { ConversationItem } from '@/domain/herdr';
import { ChipGeometry } from '@/constants/theme';
import { ConversationActivityPanel } from './conversation-activity-panel';
import { ActivityLayout } from './conversation-activity-layout';
import { PlanStep, ToolActivityRow } from './conversation-activity-rows';

let mockDimensions = { width: 390, height: 844, scale: 1, fontScale: 1 };
let mockReducedMotion = true;
jest.mock('@/hooks/use-reduce-motion', () => ({ useReducedMotion: () => mockReducedMotion }));
jest.mock('@/hooks/use-foreground', () => ({ useForeground: () => true }));
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true, default: () => mockDimensions,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('@/components/ui/glass-surface', () => ({
  GlassSurface: ({ children }: { children: import('react').ReactNode }) => children,
}));
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => jest.requireActual<typeof import('@/constants/theme')>('@/constants/theme').Colors,
}));

type Props = ComponentProps<typeof ConversationActivityPanel>;
const tool: ConversationItem = {
  id: 'read', kind: 'tool_activity', title: 'Reading', state: 'running', detail: 'file.ts',
};
const plan: ConversationItem = {
  id: 'plan', kind: 'todo_update', todos: [
    { text: 'Finished', state: 'done' }, { text: 'Working', state: 'in_progress' },
    { text: 'Blocked', state: 'blocked' }, { text: 'Cancelled', state: 'cancelled' },
    { text: 'Latest step', state: 'pending' },
  ],
};

describe('separate glass activity section', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let props: Props;
  let back: jest.SpyInstance;
  let remove: jest.Mock;

  function render(overrides: Partial<Props> = {}) {
    props = { ...props, ...overrides };
    TestRenderer.act(() => {
      if (renderer) renderer.update(createElement(ConversationActivityPanel, props));
      else renderer = TestRenderer.create(createElement(ConversationActivityPanel, props));
    });
  }
  function node(testID: string) {
    return renderer!.root.findAll((entry) => entry.props.testID === testID, { deep: false })[0];
  }
  function open(kind: 'plan' | 'tools') {
    TestRenderer.act(() => node(`activity-${kind}-chip`).props.onPress());
  }
  function close() {
    TestRenderer.act(() => node('activity-collapse').props.onPress());
  }
  function expandedClearance() {
    return Math.min(260, (mockDimensions.height - 44 - Math.max(34, props.keyboardInset)) * 0.32) + 14;
  }
  beforeEach(() => {
    mockDimensions = { width: 390, height: 844, scale: 1, fontScale: 1 };
    mockReducedMotion = true;
    props = { items: [tool, plan], sessionKey: 'a:session-a', active: true, keyboardInset: 0 };
    remove = jest.fn();
    back = jest.spyOn(BackHandler, 'addEventListener').mockReturnValue({ remove });
  });
  afterEach(() => {
    TestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
    jest.restoreAllMocks();
  });

  it('shows only separate, horizontally swipeable glass chips with compact visuals and full touch targets', () => {
    render();
    expect(renderer!.root.findByType(ScrollView).props.horizontal).toBe(true);
    expect(renderer!.root.findByType(ScrollView).props.showsHorizontalScrollIndicator).toBe(false);
    expect(node('activity-plan-chip').props.accessibilityLabel).toBe('Show plan');
    expect(node('activity-tools-chip').props.accessibilityLabel).toBe('Show tools');
    const chipStyle = node('activity-plan-chip').props.style({ pressed: false });
    expect(StyleSheet.flatten(chipStyle).minHeight).toBe(44);
    const surfaces = renderer!.root.findAllByType(GlassSurface);
    expect(surfaces).toHaveLength(2);
    expect(surfaces[0].props.tone).toBe('chrome');
    expect(StyleSheet.flatten(surfaces[0].props.style).minHeight).toBe(38);
    expect(StyleSheet.flatten(node('activity-plan-content').props.style)).toMatchObject({
      minHeight: ChipGeometry.minHeight - ActivityLayout.borderWidth * 2,
      paddingHorizontal: 12, gap: 4,
    });
    expect(StyleSheet.flatten(node('activity-plan-shadow').props.style).boxShadow).toBeDefined();
    expect(renderer!.root.findAllByType(Modal)).toHaveLength(0);
    expect(node('activity-panel')).toBeUndefined();
    expect(StyleSheet.flatten(node('activity-section').props.style)).toMatchObject({
      position: 'absolute', left: 16, right: 16, top: 4, backgroundColor: 'transparent',
    });
    expect(StyleSheet.flatten(node('activity-strip').props.style).backgroundColor).toBe('transparent');
    for (const section of ['plan', 'tools']) {
      const children = node(`activity-${section}-content`).props.children;
      expect(children[0].type).toBe(AppIcon);
      expect(children[0].props.name.ios).toBe('chevron.down');
    }
  });

  it('replaces the strip with one floating glass surface, without a modal or nested plan card', () => {
    render();
    const closedTop = StyleSheet.flatten(node('activity-plan-chip').props.style({ pressed: false })).paddingTop;
    open('plan');
    expect(StyleSheet.flatten(node('activity-panel-shadow').props.style).marginTop).toBe(closedTop);
    expect(StyleSheet.flatten(node('activity-panel').props.style)).toMatchObject({
      borderRadius: 18, borderWidth: ActivityLayout.borderWidth,
    });
    expect(node('activity-strip')).toBeUndefined();
    expect(node('activity-panel').props.tone).toBe('chrome');
    expect(node('activity-panel').props.strength).toBe('strong');
    expect(renderer!.root.findAllByType(GlassSurface)).toHaveLength(1);
    expect(renderer!.root.findAllByType(Modal)).toHaveLength(0);
    expect(renderer!.root.findAllByType(ToolActivityRow)).toHaveLength(0);
    expect(node('activity-collapse').props.accessibilityLabel).toBe('Collapse plan');
    expect(node('activity-panel').props.accessible).toBe(false);
    expect(node('activity-panel').props.accessibilityLabel).toBeUndefined();
    expect(StyleSheet.flatten(node('activity-content').props.contentContainerStyle)).toMatchObject({
      paddingHorizontal: 12, paddingVertical: 0,
    });
    expect(StyleSheet.flatten(node('activity-viewport').props.style)).toMatchObject({
      overflow: 'hidden',
    });
    expect(node('activity-bottom-space')).toBeDefined();
    expect(node('activity-footer')).toBeUndefined();
    expect(node('activity-heading').props.children.props.testID).toBe('activity-collapse');
    expect(node('activity-disclosure-chevron').props.children.props.name.ios).toBe('chevron.down');
    const collapseArea = StyleSheet.flatten(node('activity-collapse').props.style({ pressed: false }));
    expect(collapseArea.position).toBeUndefined();
    expect(collapseArea.minHeight).toBeUndefined();
    expect(StyleSheet.flatten(node('activity-plan-heading').props.style).minHeight).toBe(ActivityLayout.headingMinHeight);
    close();
    expect(node('activity-strip')).toBeDefined();
    open('tools');
    expect(renderer!.root.findAllByType(PlanStep)).toHaveLength(0);
    expect(renderer!.root.findAllByType(ToolActivityRow)).toHaveLength(1);
    expect(StyleSheet.flatten(node('activity-content').props.contentContainerStyle).gap).toBe(8);
    const toolRow = renderer!.root.findAllByProps({ accessibilityLabel: 'Reading. running. file.ts' })[0];
    expect(StyleSheet.flatten(toolRow.props.style).paddingVertical).toBe(0);
  });

  it.each(['plan', 'tools'] as const)('preserves the original left gutter and matches it on the right in %s content', (section) => {
    render();
    open(section);
    const contentStyle = StyleSheet.flatten(node('activity-content').props.contentContainerStyle);
    expect(contentStyle.paddingHorizontal).toBe(12);
    expect(contentStyle.paddingLeft).toBeUndefined();
    expect(contentStyle.paddingRight).toBeUndefined();
    const label = section === 'plan' ? 'Finished, done' : 'Reading. running. file.ts';
    const row = renderer!.root.findAllByProps({ accessibilityLabel: label })[0];
    const markStyle = StyleSheet.flatten(row.props.children[0].props.style);
    expect(markStyle).toMatchObject({ width: 32, minHeight: 18, alignItems: 'flex-end' });
    expect(StyleSheet.flatten(row.props.style).paddingRight).toBe(markStyle.width - 14);
    expect(StyleSheet.flatten(row.props.style).gap).toBe(ChipGeometry.gap);
  });

  it.each(['plan', 'tools'] as const)('keeps %s labels vertically aligned across expansion and centers the expanded title', (section) => {
    render();
    const collapsed = node(`activity-${section}-content`);
    const collapsedStyle = StyleSheet.flatten(collapsed.props.style);
    expect(collapsedStyle.minHeight + ActivityLayout.borderWidth * 2).toBe(38);
    const collapsedTop = StyleSheet.flatten(node(`activity-${section}-chip`).props.style({ pressed: false })).paddingTop;
    const children = collapsed.props.children;
    const label = children[2];
    expect(label.props.type).toBe('caption');
    open(section);
    const expanded = node(`activity-${section}-heading`);
    const expandedStyle = StyleSheet.flatten(expanded.props.style);
    expect(expandedStyle).toMatchObject({
      minHeight: collapsedStyle.minHeight,
      alignItems: 'center',
      flexDirection: collapsedStyle.flexDirection,
      paddingHorizontal: collapsedStyle.paddingHorizontal,
    });
    expect(StyleSheet.flatten(node('activity-panel-shadow').props.style).marginTop).toBe(collapsedTop);
    const viewportStyle = StyleSheet.flatten(node('activity-viewport').props.style);
    expect(viewportStyle.marginTop ?? viewportStyle.marginVertical ?? 0).toBe(0);
    expect(expandedStyle.minHeight + ActivityLayout.borderWidth * 2).toBe(38);
    const expandedLabel = expanded.props.children[1];
    expect(expandedLabel.props.type).toBe(label.props.type);
    expect(expandedLabel.props.children).toBe(label.props.children);
    expect(StyleSheet.flatten(expandedLabel.props.style).textAlign).toBe('center');
    expect(StyleSheet.flatten(node('activity-heading-leading').props.style)).toMatchObject({ flex: 1, minWidth: 0 });
    expect(StyleSheet.flatten(node('activity-heading-trailing').props.style)).toMatchObject({ flex: 1, minWidth: 0 });
    expect(node('activity-disclosure-chevron').props.children.props.size).toBe(children[0].props.size);
    expect(node('activity-heading-leading').props.children[1].props.size).toBe(children[1].props.size);
    expect(node('activity-heading').props.style).toBeUndefined();
    expect(node('activity-viewport').findAllByProps({ testID: 'activity-collapse' })).toHaveLength(0);
    expect(node('activity-viewport').findAllByType(FlatList)).toHaveLength(1);
    expect(renderer!.root.findAllByType(ThemedText).every((text) => text.props.type === 'caption')).toBe(true);
  });

  it('gives running and completed markers the same footprint and keeps status out of the description column', () => {
    render();
    open('tools');
    const indicator = renderer!.root.findByType(ActivityIndicator);
    expect(indicator.props.size).toBe(ActivityLayout.iconSize);
    const toolRow = renderer!.root.findAllByProps({ accessibilityLabel: 'Reading. running. file.ts' })[0];
    const markerStyle = StyleSheet.flatten(toolRow.props.children[0].props.style);
    expect(toolRow.props.children).toHaveLength(2);
    const copy = toolRow.props.children[1];
    const [heading, detail] = copy.props.children;
    expect(heading.props.testID).toBe('activity-tool-title-row');
    expect(heading.props.children[1].props.children).toBe('Running');
    expect(detail.props.children).toBe('file.ts');
    expect(StyleSheet.flatten(copy.props.style)).toMatchObject({ flex: 1, minWidth: 0, gap: 4 });
    render({ items: [{ ...tool, state: 'completed' }, plan] });
    const completed = renderer!.root.findAllByProps({ accessibilityLabel: 'Reading. completed. file.ts' })[0];
    expect(StyleSheet.flatten(completed.props.children[0].props.style))
      .toEqual(markerStyle);
    expect(completed.props.children[0].props.children.props.size).toBe(ActivityLayout.iconSize);
  });

  it('opens the plan at its bottom using stable inverted rows rather than deferred scrolling', () => {
    render();
    open('plan');
    const list = renderer!.root.findByType(FlatList);
    expect(list.props.inverted).toBe(true);
    expect(list.props.data.map((row: { todo: { text: string } }) => row.todo.text))
      .toEqual(['Latest step', 'Cancelled', 'Blocked', 'Working', 'Finished']);
    expect(list.props.initialScrollIndex).toBeUndefined();
    expect(list.props.maintainVisibleContentPosition).toEqual({
      minIndexForVisible: 0, autoscrollToTopThreshold: 24,
    });

    expect(list.props.onContentSizeChange).toBeUndefined();
    for (const label of [
      'Finished, done', 'Working, in progress', 'Blocked, blocked',
      'Cancelled, cancelled', 'Latest step, pending',
    ]) {
      expect(renderer!.root.findAll((entry) => entry.props.accessibilityLabel === label).length).toBeGreaterThan(0);
    }
    const cancelled = renderer!.root.findAllByProps({ accessibilityLabel: 'Cancelled, cancelled' })[0];
    expect(cancelled.props.children[0].props.children.props.name.android).toBe('close');
  });

  it('measures only its overlay clearance and does not paint a full-width backing or shadow', () => {
    const onHeightChange = jest.fn();
    render({ onHeightChange });
    TestRenderer.act(() => node('activity-section').props.onLayout({ nativeEvent: { layout: { height: 44 } } }));
    expect(onHeightChange).toHaveBeenCalledWith(52);
    const section = StyleSheet.flatten(node('activity-section').props.style);
    expect(section.backgroundColor).toBe('transparent');
    expect(section.boxShadow).toBeUndefined();
    expect(node('activity-section').props.pointerEvents).toBe('box-none');
    expect(StyleSheet.flatten(node('activity-strip').props.style)).toMatchObject({
      alignSelf: 'flex-start', maxWidth: '100%',
    });
    open('plan');
    TestRenderer.act(() => node('activity-section').props.onLayout({ nativeEvent: { layout: { height: 260 } } }));
    expect(onHeightChange).toHaveBeenLastCalledWith(expandedClearance());
    expect(StyleSheet.flatten(node('activity-panel-shadow').props.style).boxShadow).toBeDefined();
  });

  it.each(['session', 'visibility', 'keyboard', 'viewport', 'cleared-plan'] as const)(
    'resets expanded transcript clearance before native layout on %s changes', (change) => {
      const onHeightChange = jest.fn();
      render({ onHeightChange });
      open('plan');
      TestRenderer.act(() => node('activity-section').props.onLayout({ nativeEvent: { layout: { height: 266 } } }));
      expect(onHeightChange).toHaveBeenLastCalledWith(expandedClearance());
      if (change === 'session') render({ sessionKey: 'new-session' });
      else if (change === 'visibility') render({ active: false });
      else if (change === 'keyboard') render({ keyboardInset: 250 });
      else if (change === 'cleared-plan') render({ items: [tool] });
      else {
        mockDimensions = { ...mockDimensions, width: 320 };
        render();
      }
      expect(onHeightChange).toHaveBeenLastCalledWith(52);
      render({ items: [] });
      expect(onHeightChange).toHaveBeenLastCalledWith(0);
      render({ items: [tool] });
      expect(onHeightChange).toHaveBeenLastCalledWith(52);
    },
  );

  it('opens tools at the newest bottom content and preserves the list during live updates', () => {
    const newer: ConversationItem = { ...tool, id: 'new', title: 'Latest tool', state: 'pending' };
    render({ items: [tool, newer, plan] });
    open('tools');
    const list = renderer!.root.findByType(FlatList);
    const anchor = list.props.maintainVisibleContentPosition;
    const instance = list.instance;
    expect(list.props.data.map((row: { id: string }) => row.id)).toEqual(['new', 'read']);
    render({ items: [{ ...tool, state: 'completed' }, { ...newer, state: 'failed' }, plan] });
    expect(renderer!.root.findByType(FlatList).instance).toBe(instance);
    expect(renderer!.root.findByType(FlatList).props.maintainVisibleContentPosition).toBe(anchor);
    close();
    expect(node('activity-tools-chip').props.accessibilityHint).toContain('1 failed');
    expect(node('activity-failure-dot')).toBeDefined();
    open('tools');
    expect(renderer!.root.findByType(FlatList).instance).not.toBe(instance);
  });

  it.each(['back', 'escape', 'collapse'])('closes with %s and restores the chips', (method) => {
    render();
    open('plan');
    TestRenderer.act(() => {
      if (method === 'back') expect(back.mock.calls.at(-1)?.[1]()).toBe(true);
      else if (method === 'escape') node('activity-panel').props.onAccessibilityEscape();
      else node('activity-collapse').props.onPress();
    });
    expect(node('activity-panel')).toBeUndefined();
    expect(node('activity-strip')).toBeDefined();
    expect(remove).toHaveBeenCalled();
  });

  it('resets on session, visibility and viewport changes', () => {
    render(); open('plan');
    render({ sessionKey: 'a:new-session' });
    expect(node('activity-panel')).toBeUndefined();
    open('tools');
    render({ active: false });
    expect(node('activity-tools-chip').props.disabled).toBe(true);
    render({ active: true });
    expect(node('activity-panel')).toBeUndefined();
    open('plan');
    mockDimensions = { ...mockDimensions, width: 568, height: 320 };
    render();
    expect(node('activity-panel')).toBeUndefined();
  });

  it('replaces the latest plan, and removes a cleared section without reopening stale content', () => {
    render(); open('plan');
    const latest: ConversationItem = { id: 'latest', kind: 'todo_update', todos: [{ text: 'New plan', state: 'done' }] };
    render({ items: [tool, plan, latest] });
    expect(renderer!.root.findAllByType(PlanStep)).toHaveLength(1);
    expect(renderer!.root.findByType(PlanStep).props.todo.text).toBe('New plan');
    render({ items: [tool, plan, { ...latest, todos: [] }] });
    expect(node('activity-panel')).toBeUndefined();
    expect(node('activity-plan-chip')).toBeUndefined();
    expect(node('activity-tools-chip')).toBeDefined();
    render({ items: [tool, latest] });
    expect(node('activity-panel')).toBeUndefined();
  });

  it('hides absent contexts and bounds the expanded section above the keyboard', () => {
    render({ items: [] });
    expect(node('activity-section')).toBeUndefined();
    mockDimensions = { width: 320, height: 568, scale: 1, fontScale: 1 };
    render({ items: [tool], keyboardInset: 200 });
    expect(node('activity-plan-chip')).toBeUndefined();
    open('tools');
    const style = StyleSheet.flatten(node('activity-panel').props.style);
    const panelHeight = StyleSheet.flatten(node('activity-section').props.style).height - 6;
    expect(panelHeight).toBeGreaterThan(0);
    expect(panelHeight).toBeLessThanOrEqual((568 - 44 - 200) * 0.32);
    expect(style.position).toBeUndefined();
  });

  it('retires body hit targets immediately and ignores stale close completions on rapid reopen', () => {
    mockReducedMotion = false;
    const completions: ((result: { finished: boolean }) => void)[] = [];
    jest.spyOn(Animated, 'timing').mockImplementation(() => ({
      start: (callback) => { if (callback) completions.push(callback); }, stop: jest.fn(), reset: jest.fn(),
    }));
    const onHeightChange = jest.fn();
    render({ onHeightChange });
    open('tools');
    const list = node('activity-content').instance;
    close();
    expect(node('activity-viewport').props.pointerEvents).toBe('none');
    expect(node('activity-viewport').props.accessibilityElementsHidden).toBe(true);
    expect(node('activity-collapse').props.accessibilityState.expanded).toBe(false);
    expect(onHeightChange).toHaveBeenLastCalledWith(expandedClearance());
    const closing = completions.at(-1)!;
    close();
    TestRenderer.act(() => closing({ finished: true }));
    expect(node('activity-content').instance).toBe(list);
    expect(node('activity-viewport').props.pointerEvents).toBe('auto');
    close();
    TestRenderer.act(() => completions.at(-1)!({ finished: true }));
    expect(node('activity-strip')).toBeDefined();
    expect(onHeightChange).toHaveBeenLastCalledWith(52);
  });
});
