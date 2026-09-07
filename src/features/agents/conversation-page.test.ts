import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { Stack, useLocalSearchParams } from 'expo-router';

import AgentConversationScreen from '@/app/agents/[id]';
import { EMPTY_RUNTIME, remoteAgentSchema, type AgentConversation } from '@/domain/herdr';
import { ActionMenu } from '@/components/ui/action-menu';
import { herdrRepository } from '@/services/herdr-repository';
import { useConnectionSnapshot, useForeground, usePendingCommands } from '@/features/connection/use-connection';
import { ConversationComposer } from './conversation-composer';
import { ConversationMessageList } from './conversation-message-list';
import { HumanRequestBar } from './human-request-bar';
import { useConversationController } from './use-conversation-controller';
import { useAgentConversation, useHerdr } from './use-herdr';

const mockSchedule = jest.fn();
const mockFollowLatest = jest.fn();
const mockRetry = jest.fn();
let mockFocused = true;

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), dismissTo: jest.fn() },
  Stack: { Screen: () => null },
  useLocalSearchParams: jest.fn(),
  useIsFocused: () => mockFocused,
  useFocusEffect: (callback: () => (() => void) | void) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(callback, [callback]);
  },
}));
jest.mock('@/components/ui/screen', () => ({
  Screen: ({ children }: { children: import('react').ReactNode }) => children,
}));
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/components/ui/action-menu', () => ({ ActionMenu: () => null }));
jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => jest.requireActual<typeof import('@/constants/theme')>('@/constants/theme').Colors,
}));
jest.mock('@/hooks/use-keyboard-overlap', () => ({
  useKeyboardOverlap: () => ({ ref: null, inset: 80, measure: () => undefined }),
}));
jest.mock('./use-conversation-scroll', () => ({
  useConversationScroll: () => ({
    following: true, schedule: mockSchedule, followLatest: mockFollowLatest,
  }),
}));
jest.mock('./use-conversation-controller', () => ({ useConversationController: jest.fn() }));
jest.mock('./use-herdr', () => ({ useHerdr: jest.fn(), useAgentConversation: jest.fn() }));
jest.mock('./conversation-composer', () => ({
  ConversationComposer: ({ requestBar }: { requestBar?: import('react').ReactNode }) => requestBar,
}));
jest.mock('./conversation-message-list', () => ({ ConversationMessageList: () => null }));
jest.mock('./human-request-bar', () => ({ HumanRequestBar: () => null }));
jest.mock('@/features/connection/connection-status', () => ({ ConnectionStatus: () => null }));
jest.mock('@/features/connection/use-connection', () => ({
  useConnectionSnapshot: jest.fn(), useForeground: jest.fn(), usePendingCommands: jest.fn(),
}));
jest.mock('@/services/herdr-repository', () => ({
  herdrRepository: {
    deviceIdForAgent: jest.fn(), getPendingCommands: jest.fn(),
    loadDraft: jest.fn(), saveDraft: jest.fn(),
    sendMessage: jest.fn(), answerHumanRequest: jest.fn(),
  },
}));

const currentAgent = remoteAgentSchema.parse({
  id: 'a', deviceId: 'device-a', provider: 'copilot', providerSessionId: 'session-a',
  herdrSessionId: 'default', workspaceId: 'workspace', workspaceName: 'Workspace',
  paneId: 'pane-a', status: 'idle', title: 'Agent', focused: true, capabilities: {},
});
const currentConversation: AgentConversation = {
  agentId: 'a', provider: 'copilot', providerSessionId: 'session-a',
  semantic: true, items: [], activeHumanRequest: null,
};

describe('conversation page assembly', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let runtime: ReturnType<typeof useHerdr>;

  async function mount() {
    await TestRenderer.act(async () => { renderer = TestRenderer.create(createElement(AgentConversationScreen)); });
  }

  function composer() {
    return renderer!.root.findByType(ConversationComposer);
  }

  beforeEach(() => {
    jest.resetAllMocks();
    mockFocused = true;
    jest.mocked(useLocalSearchParams).mockReturnValue({ id: 'a' });
    runtime = {
      connection: 'connected', selectedDeviceId: 'device-a', runtime: EMPTY_RUNTIME,
      devices: {
        'device-a': {
          deviceId: 'device-a', connection: 'connected', hello: null, lastError: null,
          runtime: { ...EMPTY_RUNTIME, agents: [currentAgent] },
        },
      },
      agentCountsByDevice: { 'device-a': 1 }, hello: null, lastError: null, lastSemanticEvent: null,
    };
    jest.mocked(useHerdr).mockReturnValue(runtime);
    jest.mocked(useAgentConversation).mockReturnValue(currentConversation);
    jest.mocked(useForeground).mockReturnValue(true);
    jest.mocked(useConnectionSnapshot).mockReturnValue(undefined);
    jest.mocked(usePendingCommands).mockReturnValue([]);
    jest.mocked(useConversationController).mockReturnValue({ error: null, retry: mockRetry });
    jest.mocked(herdrRepository.deviceIdForAgent).mockReturnValue('device-a');
    jest.mocked(herdrRepository.getPendingCommands).mockReturnValue([]);
    jest.mocked(herdrRepository.loadDraft).mockResolvedValue('');
    jest.mocked(herdrRepository.saveDraft).mockResolvedValue(undefined);
    jest.mocked(herdrRepository.sendMessage).mockResolvedValue(undefined);
    jest.mocked(herdrRepository.answerHumanRequest).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await TestRenderer.act(async () => renderer?.unmount());
    renderer = undefined;
  });

  it('passes owning-device visibility and repository capabilities to the controller', async () => {
    mockFocused = false;
    jest.mocked(useForeground).mockReturnValue(false);
    await mount();
    expect(useConversationController).toHaveBeenLastCalledWith({
      conversationId: 'a', agent: currentAgent, hasOpenRequest: false,
      connected: true, focused: false, foreground: false, repository: herdrRepository,
    });
    expect(renderer!.root.findByType(ConversationMessageList).props.onRetry).toBe(mockRetry);
    expect(composer().props.keyboardOffset).toBe(80);
  });

  it('keeps read failures with the transcript instead of turning them into send failures', async () => {
    jest.mocked(useConversationController).mockReturnValue({ error: 'Read failed', retry: mockRetry });
    await mount();
    expect(renderer!.root.findByType(ConversationMessageList).props.error).toBe('Read failed');
    expect(composer().props.error).toBeNull();
  });

  it.each([[true, true], [false, false], [undefined, true]] as const)(
    'gates both model settings entries from remote support %s',
    async (remoteSupport, enabled) => {
      runtime.devices['device-a'].runtime.agents = [{
        ...currentAgent,
        capabilities: {
          ...currentAgent.capabilities,
          ...(remoteSupport === undefined ? {} : { supportsRetuning: remoteSupport }),
        },
      }];
      await mount();
      expect(composer().props.tunable).toBe(enabled);
      const options = renderer!.root.findByType(Stack.Screen).props.options;
      let header!: TestRenderer.ReactTestRenderer;
      TestRenderer.act(() => { header = TestRenderer.create(options.headerRight()); });
      try {
        const settings = header.root.findByType(ActionMenu).props.items.find((entry: { id: string }) => entry.id === 'settings');
        expect(settings.disabled).toBe(!enabled);
      } finally {
        TestRenderer.act(() => header.unmount());
      }
    },
  );

  it('durably queues only once for rapid send taps and clears the submitted draft', async () => {
    let finish!: () => void;
    jest.mocked(herdrRepository.sendMessage).mockImplementationOnce(() =>
      new Promise<void>((resolve) => { finish = resolve; }));
    await mount();
    await TestRenderer.act(async () => { composer().props.onChangeText('Send this'); });
    const send = composer().props.onSend;
    await TestRenderer.act(async () => { send(); send(); });
    expect(jest.mocked(herdrRepository.sendMessage).mock.calls).toEqual([['a', 'Send this']]);
    expect(composer().props.sending).toBe(true);
    await TestRenderer.act(async () => { finish(); });
    expect(composer().props.value).toBe('');
    expect(composer().props.sending).toBe(false);
    expect(herdrRepository.saveDraft).toHaveBeenCalledWith('a', '');
    expect(mockFollowLatest).toHaveBeenCalledTimes(1);
  });

  it('preserves newer input while an earlier draft is being queued', async () => {
    let finish!: () => void;
    jest.mocked(herdrRepository.sendMessage).mockImplementationOnce(() =>
      new Promise<void>((resolve) => { finish = resolve; }));
    await mount();
    await TestRenderer.act(async () => { composer().props.onChangeText('First'); });
    await TestRenderer.act(async () => { composer().props.onSend(); });
    await TestRenderer.act(async () => { composer().props.onChangeText('Next'); finish(); });
    expect(composer().props.value).toBe('Next');
    expect(herdrRepository.saveDraft).not.toHaveBeenCalledWith('a', '');
  });

  it('keeps the draft and reports an enqueue failure', async () => {
    jest.mocked(herdrRepository.sendMessage).mockRejectedValueOnce(new Error('Queue storage failed'));
    await mount();
    await TestRenderer.act(async () => { composer().props.onChangeText('Keep this'); });
    await TestRenderer.act(async () => { composer().props.onSend(); });
    expect(composer().props.value).toBe('Keep this');
    expect(composer().props.error).toBe('Queue storage failed');
    expect(herdrRepository.saveDraft).not.toHaveBeenCalledWith('a', '');
  });

  it('assembles a session-keyed question slot and shares its send lock with typed answers', async () => {
    const request = {
      id: 'question', kind: 'choice' as const, question: 'Continue?',
      options: [{ id: 'yes', label: 'Yes' }], allowCustomAnswer: true, multiSelect: false,
    };
    jest.mocked(useAgentConversation).mockReturnValue({ ...currentConversation, activeHumanRequest: request });
    await mount();
    const bar = renderer!.root.findByType(HumanRequestBar);
    expect(bar.props.session).toEqual({
      provider: 'copilot', paneId: 'pane-a', providerSessionId: 'session-a',
    });
    expect(composer().props.requestBar.key).toBe(JSON.stringify(['copilot', 'pane-a', 'session-a', 'question']));
    await TestRenderer.act(async () => { composer().props.onChangeText('Custom answer'); });
    bar.props.enqueueGuard.current = true;
    await TestRenderer.act(async () => { composer().props.onSend(); });
    expect(herdrRepository.answerHumanRequest).not.toHaveBeenCalled();
    bar.props.enqueueGuard.current = false;
    await TestRenderer.act(async () => { composer().props.onSend(); });
    expect(herdrRepository.answerHumanRequest).toHaveBeenCalledWith('a', 'question', { customText: 'Custom answer' });
    expect(herdrRepository.sendMessage).not.toHaveBeenCalled();
  });
});
