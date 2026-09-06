import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { FlatList, TextInput } from 'react-native';

import AgentConversationScreen from '@/app/agents/[id]';
import { ScrollEdgeFrame } from '@/components/ui/scroll-edge-frame';
import { conversationSchema, remoteAgentSchema, type AgentConversation } from '@/domain/herdr';
import { herdrRepository } from '@/services/herdr-repository';

let mockConversation: AgentConversation;
const mockAgent = remoteAgentSchema.parse({
  id: 'agent-a', provider: 'copilot', providerSessionId: 'session-a',
  herdrSessionId: 'herdr-a', workspaceId: 'space-a', workspaceName: 'Project',
  paneId: 'pane-a', title: 'Review', status: 'idle', capabilities: {}, focused: true,
});
const mockEdge = {
  onScroll: jest.fn(), onContentSizeChange: jest.fn(), onLayout: jest.fn(), scrollEventThrottle: 16,
};
const mockShouldReduceMotion = () => false;

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: 'agent-a' }),
  useFocusEffect: () => undefined,
  useIsFocused: () => true,
}));
jest.mock('@/components/ui/screen', () => ({ Screen: ({ children }: { children: import('react').ReactNode }) => children }));
jest.mock('@/components/ui/scroll-edge-frame', () => ({
  ScrollEdgeFrame: ({ children }: { children: (props: object) => import('react').ReactNode }) => children(mockEdge),
}));
jest.mock('@/components/ui/glass-surface', () => ({
  GlassSurface: ({ children }: { children: import('react').ReactNode }) => children,
  glassRim: () => ({}),
}));
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/features/connection/connection-status', () => ({ ConnectionStatus: () => null, CommandDelivery: () => null }));
jest.mock('@/hooks/use-keyboard-overlap', () => ({
  useKeyboardOverlap: () => ({ ref: null, inset: 0, measure: jest.fn() }),
}));
jest.mock('@/hooks/use-reduce-motion', () => ({ useReduceMotion: () => mockShouldReduceMotion }));
jest.mock('./use-herdr', () => ({
  useHerdr: () => ({
    devices: { 'device-a': { runtime: { agents: [mockAgent] }, connection: 'connected' } },
  }),
  useAgentConversation: () => mockConversation,
}));
jest.mock('@/features/connection/use-connection', () => ({
  useForeground: () => true,
  useConnectionSnapshot: () => ({ phase: 'connected' }),
  usePendingCommands: () => [],
}));
jest.mock('./conversation-refresh', () => ({
  conversationRefreshInterval: () => 3000,
  startConversationRefresh: () => () => undefined,
}));
jest.mock('@/services/herdr-repository', () => ({
  herdrRepository: {
    deviceIdForAgent: () => 'device-a',
    restoreConversation: jest.fn(async () => undefined),
    loadDraft: jest.fn(async () => ''),
    saveDraft: jest.fn(async () => undefined),
    getPendingCommands: () => [],
    subscribeCommands: () => () => undefined,
    sendMessage: jest.fn(async () => undefined),
    answerHumanRequest: jest.fn(async () => undefined),
  },
}));
jest.mock('@/services/herdr-bridge-transport', () => ({ isBridgeUnavailable: () => false }));

describe('chat scroll integration', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  let scrollToOffset: jest.SpyInstance;

  function list() {
    return renderer.root.findByType(FlatList);
  }

  function event(offset: number) {
    return { nativeEvent: { contentOffset: { x: 0, y: offset }, layout: { height: 600 } } };
  }

  function flush() {
    TestRenderer.act(() => jest.advanceTimersByTime(20));
  }

  function readHistory() {
    TestRenderer.act(() => {
      list().props.onScrollBeginDrag(event(0));
      renderer.root.findByType(ScrollEdgeFrame).props.onScroll(event(300));
      list().props.onScrollEndDrag(event(300));
    });
    scrollToOffset.mockClear();
  }

  function latestButton() {
    return renderer.root.findAllByProps({ accessibilityLabel: 'Scroll to latest message' })[0];
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockConversation = conversationSchema.parse({
      agentId: mockAgent.id, provider: 'copilot', semantic: true,
      items: [{ id: 'reply-a', kind: 'assistant_message', markdown: 'An existing reply.' }],
    });
    await TestRenderer.act(async () => {
      renderer = TestRenderer.create(createElement(AgentConversationScreen));
    });
    scrollToOffset = jest.spyOn(list().instance, 'scrollToOffset').mockImplementation(() => undefined);
    flush();
    scrollToOffset.mockClear();
  });

  afterEach(() => {
    TestRenderer.act(() => renderer.unmount());
    scrollToOffset.mockRestore();
    jest.useRealTimers();
  });

  it('follows streamed content and late layouts while preserving edge-fade handlers', () => {
    expect(list().props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 });
    TestRenderer.act(() => {
      list().props.onContentSizeChange(360, 3000);
      list().props.onLayout(event(0));
    });
    flush();
    expect(mockEdge.onContentSizeChange).toHaveBeenCalledWith(360, 3000);
    expect(mockEdge.onLayout).toHaveBeenCalled();
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: false });
    mockConversation = {
      ...mockConversation,
      items: [{ id: 'reply-a', kind: 'assistant_message', markdown: 'A streaming reply.\n'.repeat(80) }],
    };
    TestRenderer.act(() => renderer.update(createElement(AgentConversationScreen)));
    flush();
    expect(scrollToOffset).toHaveBeenCalledTimes(2);
  });

  it('keeps native anchoring stable through history, Latest, incoming content and history again', () => {
    const anchor = list().props.maintainVisibleContentPosition;
    readHistory();
    expect(list().props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 });
    expect(latestButton()).toBeDefined();
    TestRenderer.act(() => list().props.onContentSizeChange(360, 5000));
    flush();
    expect(scrollToOffset).not.toHaveBeenCalled();
    TestRenderer.act(() => latestButton().props.onPress());
    flush();
    expect(list().props.maintainVisibleContentPosition).toBe(anchor);
    expect(latestButton()).toBeUndefined();
    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: true });
    mockConversation = {
      ...mockConversation,
      items: [...mockConversation.items, { id: 'reply-b', kind: 'assistant_message', markdown: 'More incoming content.\n'.repeat(80) }],
    };
    TestRenderer.act(() => renderer.update(createElement(AgentConversationScreen)));
    TestRenderer.act(() => list().props.onContentSizeChange(360, 9000));
    flush();
    readHistory();
    expect(list().props.maintainVisibleContentPosition).toBe(anchor);
    TestRenderer.act(() => list().props.onContentSizeChange(360, 9100));
    flush();
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  it('follows a long outgoing question before enqueue completes and again after its row measures', async () => {
    readHistory();
    const question = 'A long question about the current implementation.\n'.repeat(60);
    let finish!: () => void;
    jest.mocked(herdrRepository.sendMessage).mockImplementationOnce(() =>
      new Promise<void>((resolve) => { finish = resolve; }));
    TestRenderer.act(() => renderer.root.findByType(TextInput).props.onChangeText(question));
    TestRenderer.act(() => renderer.root.findAllByProps({ accessibilityLabel: 'Send' })[0].props.onPress());
    flush();
    expect(herdrRepository.sendMessage).toHaveBeenCalledWith(mockAgent.id, question.trim());
    expect(list().props.maintainVisibleContentPosition).toEqual({ minIndexForVisible: 0 });
    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: true });
    mockConversation = {
      ...mockConversation,
      items: [...mockConversation.items, { id: 'queued-a', kind: 'user_message', text: question, delivery: 'queued' }],
    };
    await TestRenderer.act(async () => {
      renderer.update(createElement(AgentConversationScreen));
      finish();
    });
    flush();
    expect(renderer.root.findByType(TextInput).props.value).toBe('');
    scrollToOffset.mockClear();
    TestRenderer.act(() => list().props.onContentSizeChange(360, 9000));
    flush();
    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: false });
  });

  it('does not override a reader who scrolls up while a send is completing', async () => {
    let finish!: () => void;
    jest.mocked(herdrRepository.sendMessage).mockImplementationOnce(() =>
      new Promise<void>((resolve) => { finish = resolve; }));
    TestRenderer.act(() => renderer.root.findByType(TextInput).props.onChangeText('A question'));
    TestRenderer.act(() => renderer.root.findAllByProps({ accessibilityLabel: 'Send' })[0].props.onPress());
    readHistory();
    await TestRenderer.act(async () => finish());
    flush();
    expect(latestButton()).toBeDefined();
    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  it('resumes following when an answer option is sent', async () => {
    mockConversation = {
      ...mockConversation,
      activeHumanRequest: {
        id: 'request-a', kind: 'choice', question: 'Which target?',
        options: [{ id: 'one', label: 'One target' }], allowCustomAnswer: true, multiSelect: false,
      },
    };
    TestRenderer.act(() => renderer.update(createElement(AgentConversationScreen)));
    readHistory();
    await TestRenderer.act(async () => {
      renderer.root.findAllByProps({ accessibilityLabel: 'One target' })[0].props.onPress();
    });
    flush();
    expect(herdrRepository.answerHumanRequest).toHaveBeenCalledWith(mockAgent.id, 'request-a', { selectedOptionIds: ['one'] });
    expect(latestButton()).toBeUndefined();
    expect(scrollToOffset).toHaveBeenCalledWith({ offset: 0, animated: true });
  });
});
