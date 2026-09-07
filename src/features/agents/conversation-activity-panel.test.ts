import { createElement, type ComponentProps } from 'react';
import TestRenderer from 'react-test-renderer';
import { FlatList, Modal, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Colors } from '@/constants/theme';
import type { ConversationItem } from '@/domain/herdr';
import { ConversationActivityPanel } from './conversation-activity-panel';
import { PlanRow, ToolActivityRow } from './conversation-activity-rows';

let mockDimensions = { width: 390, height: 844, scale: 1, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true, default: () => mockDimensions,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));
jest.mock('expo-router', () => ({ useIsFocused: () => true, useFocusEffect: jest.fn() }));
jest.mock('@/components/ui/glass-surface', () => ({ glassRim: () => ({}) }));
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
    { text: 'Blocked', state: 'blocked' }, { text: 'Pending', state: 'pending' },
  ],
};

describe('ConversationActivityPanel', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let props: Props;
  let measure: jest.SpyInstance;

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

  function open() {
    TestRenderer.act(() => node('activity-trigger').props.onPress());
  }

  function text() {
    return renderer!.root.findAllByType(ThemedText).map((entry) => entry.props.children).flat().join(' ');
  }

  beforeEach(() => {
    mockDimensions = { width: 390, height: 844, scale: 1, fontScale: 1 };
    props = { items: [tool, plan], sessionKey: 'a:session-a', active: true, keyboardInset: 0 };
    measure = jest.spyOn(View.prototype, 'measureInWindow').mockImplementation((callback) => {
      callback(16, 100, 358, 58);
    });
  });

  afterEach(() => {
    TestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
    jest.restoreAllMocks();
  });

  it('starts collapsed, summarizes activity, and toggles the top popup without nested disclosures', () => {
    render();
    expect(node('activity-trigger').props.accessibilityState).toEqual({ expanded: false });
    expect(node('activity-trigger').props.accessibilityLabel).toContain('1 tool call · 1 running · Plan 1 of 4');
    expect(renderer!.root.findAllByType(Modal)).toHaveLength(0);
    expect(text()).not.toContain('file.ts');
    open();
    expect(node('activity-trigger').props.accessibilityState).toEqual({ expanded: true });
    expect(renderer!.root.findAllByType(Modal)).toHaveLength(1);
    expect(text()).toContain('file.ts');
    expect(renderer!.root.findAllByType(ToolActivityRow)).toHaveLength(1);
    expect(renderer!.root.findAllByType(PlanRow)).toHaveLength(1);
    expect(node('activity-list').props.nestedScrollEnabled).toBe(true);
    TestRenderer.act(() => node('activity-close').props.onPress());
    expect(renderer!.root.findAllByType(Modal)).toHaveLength(0);
  });

  it.each(['backdrop', 'back', 'escape'])('dismisses via %s', (method) => {
    render();
    open();
    TestRenderer.act(() => {
      if (method === 'backdrop') node('activity-backdrop').props.onPress();
      else if (method === 'back') renderer!.root.findByType(Modal).props.onRequestClose();
      else renderer!.root.findAll((entry) => typeof entry.props.onAccessibilityEscape === 'function', { deep: false })[0].props.onAccessibilityEscape();
    });
    expect(renderer!.root.findAllByType(Modal)).toHaveLength(0);
  });

  it('resets for a changed route/session and blur/background, without reopening on return', () => {
    render();
    open();
    render({ sessionKey: 'a:session-b' });
    expect(renderer!.root.findAllByType(Modal)).toHaveLength(0);
    open();
    render({ sessionKey: 'b:session-b' });
    expect(renderer!.root.findAllByType(Modal)).toHaveLength(0);
    open();
    render({ active: false });
    expect(renderer!.root.findAllByType(Modal)).toHaveLength(0);
    render({ active: true });
    expect(renderer!.root.findAllByType(Modal)).toHaveLength(0);
  });

  it('ignores native measurements that complete after session change or inactivity', () => {
    let finish!: (x: number, y: number, width: number, height: number) => void;
    measure.mockImplementation((callback) => { finish = callback; });
    render();
    open();
    render({ sessionKey: 'new-session' });
    TestRenderer.act(() => finish(16, 100, 358, 58));
    expect(renderer!.root.findAllByType(Modal)).toHaveLength(0);
    open();
    render({ active: false });
    TestRenderer.act(() => finish(16, 100, 358, 58));
    render({ active: true });
    expect(renderer!.root.findAllByType(Modal)).toHaveLength(0);
  });

  it('updates errors and tool states live, keeps all tools newest first, and surfaces collapsed failures', () => {
    render();
    open();
    const failed: ConversationItem = { ...tool, state: 'failed', detail: 'Permission denied' };
    const pending: ConversationItem = { ...tool, id: 'queued', title: 'Next tool', state: 'pending' };
    const cancelled: ConversationItem = { ...tool, id: 'cancelled', title: 'Cancelled tool', state: 'cancelled' };
    render({ items: [failed, plan, pending, cancelled] });
    expect(renderer!.root.findAllByType(Modal)).toHaveLength(1);
    expect(renderer!.root.findByType(FlatList).props.data.map((item: { id: string }) => item.id))
      .toEqual(['cancelled', 'queued', 'read']);
    expect(text()).toContain('Permission denied');
    expect(text()).toContain('Failed');
    expect(text()).toContain('Pending');
    expect(text()).toContain('Cancelled');
    TestRenderer.act(() => node('activity-close').props.onPress());
    expect(node('activity-trigger').props.accessibilityLabel).toContain('3 tool calls · 1 failed · 1 pending');
    expect(node('activity-trigger').props.accessibilityLabel).not.toContain('running');
    const failureSummary = renderer!.root.findAllByType(ThemedText).find((entry) =>
      typeof entry.props.children === 'string' && entry.props.children.includes('1 failed'))!;
    expect(StyleSheet.flatten(failureSummary.props.style).color).toBe(Colors.danger);
  });

  it('shows every plan state and replaces the whole plan, with empty updates clearing history', () => {
    render();
    open();
    for (const label of ['Finished, done', 'Working, in progress', 'Blocked, blocked', 'Pending, pending']) {
      expect(renderer!.root.findAll((entry) => entry.props.accessibilityLabel === label).length).toBeGreaterThan(0);
    }
    const latest: ConversationItem = { id: 'latest', kind: 'todo_update', todos: [{ text: 'New plan', state: 'done' }] };
    render({ items: [tool, plan, { id: 'turn', kind: 'user_message', text: 'Next' }, latest] });
    expect(renderer!.root.findAllByType(PlanRow)).toHaveLength(1);
    expect(text()).toContain('New plan');
    expect(text()).not.toContain('Finished');
    render({ items: [tool, plan, latest, { id: 'clear', kind: 'todo_update', todos: [] }] });
    expect(renderer!.root.findAllByType(PlanRow)).toHaveLength(0);
    expect(text()).not.toContain('New plan');
    expect(text()).not.toContain('Plan 1 of');
  });

  it('hides empty activity and never invents a plan from tool output', () => {
    render({ items: [] });
    expect(node('activity-trigger')).toBeUndefined();
    render({ items: [tool] });
    open();
    expect(renderer!.root.findAllByType(PlanRow)).toHaveLength(0);
    render({ items: [plan, { id: 'clear', kind: 'todo_update', todos: [] }] });
    expect(node('activity-trigger')).toBeUndefined();
    expect(renderer!.root.findAllByType(Modal)).toHaveLength(0);
  });

  it('bounds the downward popup above keyboard/system areas and closes on viewport changes', () => {
    mockDimensions = { width: 320, height: 568, scale: 1, fontScale: 1 };
    measure.mockImplementation((callback) => callback(16, 100, 288, 58));
    render({ keyboardInset: 200 });
    open();
    const style = StyleSheet.flatten(node('activity-popup').props.style);
    expect(style.position).toBe('absolute');
    expect(style.top).toBeGreaterThanOrEqual(158);
    expect(style.width).toBe(288);
    expect(style.maxHeight).toBeGreaterThan(0);
    expect(style.maxHeight).toBeLessThanOrEqual((568 - 44 - 200) * 0.4);
    expect(style.top + style.maxHeight).toBeLessThanOrEqual(568 - 200);
    expect(renderer!.root.findByType(Modal).props).toMatchObject({ transparent: true, statusBarTranslucent: true });
    render({ keyboardInset: 0 });
    expect(renderer!.root.findAllByType(Modal)).toHaveLength(0);
    open();
    mockDimensions = { ...mockDimensions, width: 568, height: 320 };
    render();
    expect(renderer!.root.findAllByType(Modal)).toHaveLength(0);
  });
});
