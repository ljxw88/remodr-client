import {
  agentProviderSchema,
  bridgeEventSchema,
  bridgeHelloSchema,
  bridgeResponseSchema,
  closeSpaceResultSchema,
  conversationSchema,
  createAgentResultSchema,
  createAgentInputSchema,
  createSpaceResultSchema,
  humanRequestSchema,
  launchableAgentProviderSchema,
  providerLabel,
  runtimeStateSchema,
} from '@/domain/herdr';

describe('Herdr mobile protocol', () => {
  it('launches OpenCode first instead of Cursor Agent', () => {
    expect(launchableAgentProviderSchema.options).toEqual(['opencode', 'copilot']);
    expect(launchableAgentProviderSchema.parse('opencode')).toBe('opencode');
    expect(providerLabel('opencode')).toBe('OpenCode');
    expect(launchableAgentProviderSchema.safeParse('cursor').success).toBe(false);
  });

  it.each(['claude', 'codex', 'cursor', 'cursor-agent', 'Cursor', 'Cursor Agent', 'future-provider'])(
    'tolerates removed/unknown %s in incoming snapshots without making it launchable',
    (provider) => {
    const snapshot = {
      connectionState: 'connected',
      workspaces: [],
      providers: [
        { provider: 'opencode', available: true },
        { provider: 'copilot', available: true },
        { provider, available: true },
      ],
      agents: [{
        id: 'legacy-agent', provider, herdrSessionId: 'default',
        workspaceId: 'w1', workspaceName: 'Work', paneId: 'p1',
        status: 'idle', title: 'Existing session', focused: false, capabilities: {},
      }],
    };
    const parsed = runtimeStateSchema.parse(snapshot);
    expect(parsed.providers.slice(0, 2).map((manifest) => manifest.provider))
      .toEqual(['opencode', 'copilot']);
    expect(parsed.providers[2]).toMatchObject({
      provider: 'unknown', available: false,
      unavailableReason: expect.stringContaining(provider),
      },
    );
    expect(parsed.agents[0]).toMatchObject({ id: 'legacy-agent', provider: 'unknown' });
    expect(parsed.providers.some((manifest) => manifest.provider === 'opencode')).toBe(true);
    expect(createAgentInputSchema.safeParse({ provider, workspaceId: 'w1' }).success).toBe(false);
    expect(createSpaceResultSchema.parse({ workspaceId: 'w1', runtime: snapshot }).runtime).toEqual(parsed);
    expect(runtimeStateSchema.parse(parsed)).toEqual(parsed);
    expect(conversationSchema.parse({
      agentId: 'legacy-agent', provider, semantic: false,
      items: [{ id: 'raw', kind: 'raw_output', text: 'Existing terminal output' }],
    })).toMatchObject({ provider: 'unknown', items: [{ text: 'Existing terminal output' }] });
  });

  it('still rejects malformed provider fields and known-provider manifest data', () => {
    for (const provider of [undefined, null, 42, {}, '']) {
      expect(agentProviderSchema.safeParse(provider).success).toBe(false);
    }
    expect(runtimeStateSchema.safeParse({
      connectionState: 'connected', agents: [], workspaces: [],
      providers: [{ provider: 'copilot', available: 'yes' }],
    }).success).toBe(false);
  });

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
    expect(
      bridgeHelloSchema.parse({
        protocol: 1,
        type: 'hello',
        bridgeVersion: '0.1.0',
        herdrVersion: 'unknown',
        herdrProtocol: null,
        capabilities: {},
      }).herdrProtocol,
    ).toBeNull();
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
      deviceId: 'device-1',
      workspaces: [
        {
          id: 'w1',
          deviceId: 'device-1',
          name: 'mobile',
          cwd: '/work/mobile',
          status: 'working',
        },
      ],
      providers: [{ provider: 'copilot', available: true }],
      agents: [
        {
          id: 'a1',
          deviceId: 'device-1',
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
    expect(runtime.workspaces[0].cwd).toBe('/work/mobile');

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

  it('preserves native OpenCode questions and permissions without raw metadata', () => {
    const questions = humanRequestSchema.parse({
      id: 'que_native',
      kind: 'choice',
      question: 'Which database?',
      options: [{ id: 'PostgreSQL', label: 'PostgreSQL' }],
      allowCustomAnswer: false,
      multiSelect: false,
      origin: 'api',
      providerSessionId: 'ses_native',
      questions: [
        {
          header: 'Database',
          question: 'Which database?',
          options: [{ id: 'PostgreSQL', label: 'PostgreSQL' }],
          allowCustomAnswer: false,
          multiSelect: false,
        },
        {
          header: 'Region',
          question: 'Which regions?',
          options: [{ id: 'Europe', label: 'Europe' }],
          allowCustomAnswer: true,
          multiSelect: true,
        },
      ],
    });
    expect(questions.questions).toHaveLength(2);
    expect(questions.questions?.[1]).toMatchObject({
      question: 'Which regions?',
      multiSelect: true,
    });

    const permission = humanRequestSchema.parse({
      id: 'per_native',
      kind: 'permission',
      question: 'Allow OpenCode to use bash?',
      options: [],
      allowCustomAnswer: false,
      multiSelect: false,
      origin: 'api',
      providerSessionId: 'ses_native',
      permission: {
        permission: 'bash',
        patterns: ['git status'],
        always: ['git *'],
      },
    });
    expect(permission.permission).toEqual({
      permission: 'bash',
      patterns: ['git status'],
      always: ['git *'],
    });
  });

  it('parses a created agent with its refreshed runtime', () => {
    const result = createAgentResultSchema.parse({
      paneId: 'p2',
      agentId: 'agent-2',
      name: 'copilot',
      runtime: {
        connectionState: 'connected',
        deviceId: 'device-1',
        workspaces: [],
        agents: [],
        providers: [{ provider: 'copilot', available: true }],
      },
    });

    expect(result.runtime.providers[0].provider).toBe('copilot');
  });

  it('parses a created space with its refreshed runtime', () => {
    const result = createSpaceResultSchema.parse({
      workspaceId: 'w2',
      runtime: {
        connectionState: 'connected',
        deviceId: 'device-1',
        workspaces: [{ id: 'w2', name: 'project', status: 'idle' }],
        agents: [],
        providers: [],
      },
    });

    expect(result.workspaceId).toBe('w2');
  });

  it('keeps an agent running a setting this build has not heard of', () => {
    // The reasoning and context vocabularies belong to the CLI and grow when
    // it updates. Parsed strictly, one agent on a newer setting took every
    // agent off the screen, because the list is parsed as a whole.
    const runtime = runtimeStateSchema.parse({
      connectionState: 'connected',
      deviceId: 'device-1',
      workspaces: [],
      providers: [],
      agents: [
        {
          id: 'a1',
          provider: 'copilot',
          herdrSessionId: 's',
          workspaceId: 'w1',
          workspaceName: 'W',
          paneId: 'p1',
          status: 'idle',
          title: 'Agent',
          focused: false,
          capabilities: {
            streamingConversation: true,
            structuredQuestions: true,
            toolActivity: true,
            todos: true,
            fallback: true,
          },
          tuning: { model: 'a-model-we-do-not-ship', effort: 'future-effort', context: 'huge' },
        },
      ],
    });

    expect(runtime.agents).toHaveLength(1);
    // The model is whatever the agent says; the other two read as unset rather
    // than as something the app would then offer as a choice.
    expect(runtime.agents[0].tuning).toEqual({
      model: 'a-model-we-do-not-ship',
      effort: null,
      context: null,
    });
  });

  it('parses a closed space with its refreshed runtime', () => {
    const result = closeSpaceResultSchema.parse({
      workspaceId: 'w2',
      runtime: {
        connectionState: 'connected',
        deviceId: 'device-1',
        workspaces: [],
        agents: [],
        providers: [],
      },
    });

    expect(result.runtime.workspaces).toEqual([]);
  });
});
