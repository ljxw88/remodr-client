import { createElement, createRef, type ComponentProps } from 'react';
import TestRenderer from 'react-test-renderer';
import { ActivityIndicator, Alert, FlatList, StyleSheet } from 'react-native';

import { MarkdownMessage } from '@/components/markdown/markdown-message';
import { ThemedText } from '@/components/themed-text';
import { ScrollEdgeFrame } from '@/components/ui/scroll-edge-frame';
import { ScrollEdgeFade } from '@/constants/theme';
import { remoteAgentSchema } from '@/domain/herdr';
import { CommandDelivery } from '@/features/connection/connection-status';
import { type ConversationDisplayItem, type TranscriptItem } from './conversation-display';
import { ConversationMessageList } from './conversation-message-list';

const mockEdge = {
  onScroll: jest.fn(),
  onContentSizeChange: jest.fn(),
  onLayout: jest.fn(),
  scrollEventThrottle: 16,
};

jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/components/markdown/markdown-message', () => ({ MarkdownMessage: () => null }));
jest.mock('@/components/ui/scroll-edge-frame', () => ({
  ScrollEdgeFrame: ({ children }: {
    children: (edge: typeof mockEdge) => import('react').ReactNode;
  }) => children(mockEdge),
}));
jest.mock('@/features/connection/connection-status', () => ({ CommandDelivery: () => null }));
jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => jest.requireActual<typeof import('@/constants/theme')>('@/constants/theme').Colors,
}));

type Props = ComponentProps<typeof ConversationMessageList>;

const agent = remoteAgentSchema.parse({
  id: 'a', provider: 'copilot', herdrSessionId: 'default', workspaceId: 'workspace',
  workspaceName: 'Workspace', paneId: 'pane-a', status: 'idle',
  title: 'Agent', focused: true, capabilities: {},
});

describe('ConversationMessageList', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let props: Props;

  function render(overrides: Partial<Props> = {}) {
    props = { ...props, ...overrides };
    TestRenderer.act(() => {
      if (renderer) renderer.update(createElement(ConversationMessageList, props));
      else renderer = TestRenderer.create(createElement(ConversationMessageList, props));
    });
  }

  function list() {
    return renderer!.root.findByType(FlatList);
  }

  function text() {
    return renderer!.root.findAllByType(ThemedText).map((node) => node.props.children).flat().join(' ');
  }

  function buttons() {
    return renderer!.root.findAll((node) =>
      node.props.accessibilityRole === 'button' && typeof node.props.onPress === 'function',
    { deep: false });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    props = {
      conversationId: 'a', data: [], listRef: createRef<FlatList<TranscriptItem>>(),
      agent, onEdit: jest.fn(), connected: true, error: null,
      hasConversation: true, bottomInset: 180, onRetry: jest.fn(),
      scroll: {
        schedule: jest.fn(), onScroll: jest.fn(), onScrollBeginDrag: jest.fn(),
        onScrollEndDrag: jest.fn(), onMomentumScrollBegin: jest.fn(), onMomentumScrollEnd: jest.fn(),
      },
    };
  });

  afterEach(() => {
    TestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
    jest.restoreAllMocks();
  });

  it('preserves inversion, row identity, tuning, ref, stable anchoring, and measured bottom space', () => {
    const data: ConversationDisplayItem[] = [{ id: 'm', kind: 'assistant_message', markdown: 'Hello' }];
    const listRef = createRef<FlatList<TranscriptItem>>();
    render({ data, listRef, topInset: 52 });
    expect(list().props).toMatchObject({
      inverted: true, keyboardShouldPersistTaps: 'handled', keyboardDismissMode: 'on-drag',
      showsVerticalScrollIndicator: false, initialNumToRender: 20, maxToRenderPerBatch: 20, windowSize: 7,
    });
    expect(list().props.data).toEqual(data);
    expect(list().props.keyExtractor(data[0])).toBe('m');
    const anchor = list().props.maintainVisibleContentPosition;
    expect(anchor).toEqual({ minIndexForVisible: 0 });
    const instance = list().instance;
    expect(listRef.current).toBe(instance);
    expect(StyleSheet.flatten(list().props.ListHeaderComponent.props.style).height).toBe(180);
    expect(StyleSheet.flatten(list().props.ListFooterComponent.props.style).height).toBe(52);
    expect(renderer!.root.findByType(ScrollEdgeFrame).props).toMatchObject({
      inverted: true, bottomHeight: Math.max(ScrollEdgeFade.bottomHeight, 180),
    });
    expect(renderer!.root.findByType(MarkdownMessage).props.children).toBe('Hello');

    render({ bottomInset: 400 });
    expect(list().props.maintainVisibleContentPosition).toBe(anchor);
    expect(list().instance).toBe(instance);
    expect(list().props.ListHeaderComponent.props.style.height).toBe(400);
    expect(renderer!.root.findByType(ScrollEdgeFrame).props.bottomHeight).toBe(400);
    render({ conversationId: 'b', bottomInset: 0 });
    expect(list().instance).not.toBe(instance);
    expect(list().props.maintainVisibleContentPosition).toBe(anchor);
    expect(renderer!.root.findByType(ScrollEdgeFrame).props.bottomHeight).toBe(ScrollEdgeFade.bottomHeight);
  });

  it('forwards edge measurements before scheduling and all gesture offsets unchanged', () => {
    render();
    jest.clearAllMocks();
    const layout = { nativeEvent: { layout: { height: 600, width: 320 } } };
    const event = { nativeEvent: { contentOffset: { y: 85 } } };
    TestRenderer.act(() => {
      list().props.onContentSizeChange(320, 1200);
      list().props.onLayout(layout);
      renderer!.root.findByType(ScrollEdgeFrame).props.onScroll(event);
      list().props.onScrollBeginDrag(event);
      list().props.onScrollEndDrag(event);
      list().props.onMomentumScrollBegin();
      list().props.onMomentumScrollEnd(event);
    });
    expect(mockEdge.onContentSizeChange).toHaveBeenCalledWith(320, 1200);
    expect(mockEdge.onLayout).toHaveBeenCalledWith(layout);
    expect(props.scroll.schedule).toHaveBeenCalledTimes(2);
    const schedule = jest.mocked(props.scroll.schedule);
    expect(mockEdge.onContentSizeChange.mock.invocationCallOrder[0]).toBeLessThan(schedule.mock.invocationCallOrder[0]);
    expect(mockEdge.onLayout.mock.invocationCallOrder[0]).toBeLessThan(schedule.mock.invocationCallOrder[1]);
    expect(list().props.onScroll).toBe(mockEdge.onScroll);
    expect(list().props.scrollEventThrottle).toBe(16);
    expect(props.scroll.onScroll).toHaveBeenCalledWith(85);
    expect(props.scroll.onScrollBeginDrag).toHaveBeenCalledWith(85);
    expect(props.scroll.onScrollEndDrag).toHaveBeenCalledWith(85);
    expect(props.scroll.onMomentumScrollBegin).toHaveBeenCalledTimes(1);
    expect(props.scroll.onMomentumScrollEnd).toHaveBeenCalledWith(85);
  });

  it('keeps empty, disconnected, loading, and retry states distinct', () => {
    render();
    expect(text()).toContain('No conversation yet.');
    render({ hasConversation: false, connected: false });
    expect(text()).toContain('Conversation will load when this device reconnects.');
    render({ connected: true });
    expect(renderer!.root.findAllByType(ActivityIndicator)).toHaveLength(1);
    render({ error: 'Read failed' });
    expect(text()).toContain('Read failed');
    const retry = buttons().find((node) =>
      node.props.accessibilityLabel === 'Retry loading conversation')!;
    TestRenderer.act(() => retry.props.onPress());
    expect(props.onRetry).toHaveBeenCalledTimes(1);
    expect(renderer!.root.findAllByType(ActivityIndicator)).toHaveLength(0);
  });

  it('keeps delivery controls and only offers edit for sent or historical messages', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    render({
      data: [
        { id: 'queued', kind: 'user_message', text: 'Queued', commandId: 'command',
          delivery: 'queued', deliveryError: 'Offline', previousSession: true },
        { id: 'sent', kind: 'user_message', text: 'Sent', delivery: 'sent' },
        { id: 'historical', kind: 'user_message', text: 'Historical' },
      ],
    });
    const rows = renderer!.root.findAll((node) => typeof node.props.onLongPress === 'function', { deep: false });
    expect(renderer!.root.findAllByType(CommandDelivery)[0].props).toEqual({
      commandId: 'command', delivery: 'queued', deliveryError: 'Offline', previousSession: true,
    });
    TestRenderer.act(() => rows[0].props.onLongPress());
    expect(alert).not.toHaveBeenCalled();
    TestRenderer.act(() => rows[1].props.onLongPress());
    expect(alert).toHaveBeenLastCalledWith('Message', undefined, [
      { text: 'Cancel', style: 'cancel' }, { text: 'Edit & resend', onPress: expect.any(Function) },
    ]);
    TestRenderer.act(() => alert.mock.calls[0][2]![1].onPress!());
    expect(props.onEdit).toHaveBeenCalledWith('Sent');
    TestRenderer.act(() => rows[2].props.onLongPress());
    TestRenderer.act(() => alert.mock.calls[1][2]![1].onPress!());
    expect(props.onEdit).toHaveBeenCalledWith('Historical');
  });

  it('removes tools, plans, and legacy groups from FlatList data, including tool-only empty state', () => {
    render({
      data: [
        { id: 'single', kind: 'tool_activity', title: 'Reading', state: 'running' },
        { id: 'plan', kind: 'todo_update', todos: [{ text: 'Working', state: 'in_progress' }] },
        {
        id: 'tools', kind: 'tool_group', items: [
          { id: 't1', kind: 'tool_activity', title: 'Reading', state: 'completed', detail: 'file.ts' },
          { id: 't2', kind: 'tool_activity', title: 'Testing', state: 'failed', detail: '1 assertion failed' },
        ],
      }],
    });
    expect(list().props.data).toEqual([]);
    expect(text()).toContain('No conversation yet.');
    expect(buttons()).toHaveLength(0);
    const message = { id: 'message', kind: 'assistant_message' as const, markdown: 'Answer' };
    render({ data: [...props.data, message] });
    expect(list().props.data).toEqual([message]);
    expect(text()).not.toContain('No conversation yet.');
    expect(renderer!.root.findByType(MarkdownMessage).props.children).toBe('Answer');
  });

  it('shows resolved questions only and preserves expandable compatibility output', () => {
    const request = {
      id: 'q', kind: 'choice' as const, question: 'Continue?', options: [],
      allowCustomAnswer: true, multiSelect: false,
    };
    render({
      data: [
        { id: 'open', kind: 'human_request', request: { ...request, question: 'Still open?' }, resolved: false },
        { id: 'closed', kind: 'human_request', request, resolved: true },
        { id: 'plan', kind: 'todo_update', todos: [
          { text: 'Finished', state: 'done' }, { text: 'Working', state: 'in_progress' },
          { text: 'Blocked', state: 'blocked' }, { text: 'Pending', state: 'pending' },
        ] },
        { id: 'raw', kind: 'raw_output', text: 'Raw transcript' },
        { id: 'status', kind: 'status_notice', status: 'idle', text: 'Waiting for your reply' },
      ],
    });
    expect(text()).not.toContain('Still open?');
    expect(text()).toContain('Continue?');
    expect(list().props.data.map((item: ConversationDisplayItem) => item.id)).toEqual(['open', 'closed', 'raw', 'status']);
    expect(text()).toContain('Waiting for your reply');
    expect(text()).not.toContain('Finished');
    expect(text()).not.toContain('Raw transcript');
    const raw = buttons()[0];
    TestRenderer.act(() => raw.props.onPress());
    expect(text()).toContain('Raw transcript');
    expect(raw.props.accessibilityState).toEqual({ expanded: true });
  });
});
