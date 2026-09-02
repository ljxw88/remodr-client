import {
  bridgeEventSchema,
  bridgeHelloSchema,
  bridgeResponseSchema,
  conversationSchema,
  runtimeStateSchema,
} from '@/domain/herdr';

describe('Herdr mobile protocol', () => {
  it('parses a hello with future capability fields', () => {
    expect(
      bridgeHelloSchema.parse({
        protocol: 1,
        type: 'hello',
        bridgeVersion: '0.1.0',
        herdrVersion: '0.8.2',
        herdrProtocol: 20,
        capabilities: { providers: ['copilot'], future: { supported: true } },
        futureField: 'ignored',
      }).herdrVersion,
    ).toBe('0.8.2');
  });

  it('parses success, error and unknown events', () => {
    expect(
      bridgeResponseSchema.parse({
        protocol: 1,
        id: 'request-1',
        type: 'response',
        ok: true,
        payload: {},
      }).ok,
    ).toBe(true);
    expect(
      bridgeResponseSchema.parse({
        protocol: 1,
        id: 'request-2',
        type: 'response',
        ok: false,
        error: { code: 'NO_AGENT', message: 'Missing' },
      }).ok,
    ).toBe(false);
    expect(
      bridgeEventSchema.parse({
        protocol: 1,
        type: 'event',
        event: 'future.event',
        data: { optional: true },
      }).event,
    ).toBe('future.event');
  });

  it('parses runtime agents and semantic conversation items', () => {
    const runtime = runtimeStateSchema.parse({
      connectionState: 'connected',
      workspaces: [{ id: 'w1', name: 'mobile', status: 'working' }],
      agents: [
        {
          id: 'a1',
          provider: 'copilot',
          herdrSessionId: 'default',
          workspaceId: 'w1',
          workspaceName: 'mobile',
          paneId: 'p1',
          status: 'working',
          title: 'Copilot',
          focused: true,
          capabilities: {},
        },
      ],
    });
    expect(runtime.agents[0].provider).toBe('copilot');

    const conversation = conversationSchema.parse({
      agentId: 'a1',
      provider: 'copilot',
      semantic: true,
      items: [
        { id: 'u1', kind: 'user_message', text: 'Fix reconnect.' },
        { id: 'm1', kind: 'assistant_message', markdown: 'I will inspect it.' },
        {
          id: 't1',
          kind: 'tool_activity',
          title: 'Reading',
          detail: 'Connection.kt',
          state: 'running',
        },
      ],
    });
    expect(conversation.items).toHaveLength(3);
  });
});
