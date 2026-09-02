import type { HerdrRuntimeState } from '@/domain/herdr';
import {
  appendOptimisticUserMessage,
  reduceAgentStatus,
} from '@/services/herdr-repository';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    setItem: jest.fn(),
    removeItem: jest.fn(),
  },
}));

const runtime: HerdrRuntimeState = {
  connectionState: 'connected',
  workspaces: [{ id: 'w1', name: 'mobile', status: 'idle' }],
  agents: [
    {
      id: 'agent-1',
      provider: 'copilot',
      herdrSessionId: 'default',
      workspaceId: 'w1',
      workspaceName: 'mobile',
      paneId: 'p1',
      status: 'idle',
      title: 'Copilot',
      focused: true,
      capabilities: {
        structuredConversation: true,
        streamingConversation: true,
        structuredQuestions: true,
        toolActivity: true,
        todos: true,
        fallback: true,
      },
    },
  ],
};

describe('Herdr runtime reducer', () => {
  it.each([
    ['working'],
    ['blocked'],
    ['done'],
    ['idle'],
  ] as const)('moves an agent to %s', (status) => {
    expect(reduceAgentStatus(runtime, 'agent-1', status).agents[0].status).toBe(status);
  });

  describe('optimistic conversation messages', () => {
    it('appends a user message without mutating the existing conversation', () => {
      const conversation = {
        agentId: 'agent-1',
        provider: 'copilot' as const,
        semantic: true,
        items: [{ id: 'a1', kind: 'assistant_message' as const, markdown: 'Ready.' }],
      };

      const optimistic = appendOptimisticUserMessage(conversation, 'Run the tests.');

      expect(conversation.items).toHaveLength(1);
      expect(optimistic.items).toHaveLength(2);
      expect(optimistic.items[1]).toMatchObject({
        kind: 'user_message',
        text: 'Run the tests.',
      });
    });
  });

  it('keeps the same snapshot for an unknown agent or unchanged state', () => {
    expect(reduceAgentStatus(runtime, 'missing', 'working')).toBe(runtime);
    expect(reduceAgentStatus(runtime, 'agent-1', 'idle')).toBe(runtime);
  });
});
