import copilot from '../../modules/remote-core/bridge/fixtures/protocol/copilot-session-replacement.json';
import claude from '../../modules/remote-core/bridge/fixtures/protocol/claude-empty-session.json';
import codex from '../../modules/remote-core/bridge/fixtures/protocol/codex-empty-session.json';
import cursor from '../../modules/remote-core/bridge/fixtures/protocol/cursor-null-session-fallback.json';
import commands from '../../modules/remote-core/bridge/fixtures/protocol/durable-command-responses.json';

import {
  agentSession,
  commandSession,
  conversationMatchesAgent,
  sameAgentSession,
} from '@/domain/agent-session';
import { supportsRetuning } from '@/domain/agent-capabilities';
import {
  bridgeResponseSchema,
  conversationSchema,
  humanRequestSchema,
  remoteAgentSchema,
} from '@/domain/herdr';

const fixtures = [
  ['copilot-session-replacement', copilot],
  ['claude-empty-session', claude],
  ['codex-empty-session', codex],
  ['cursor-null-session-fallback', cursor],
] as const;

type Frame = (typeof fixtures)[number][1]['frames'][number];

function agentFor(frame: Frame) {
  // Display-only fields are irrelevant here. Python checks the session fields
  // below against an actual normalized runtime agent, not another test schema.
  return remoteAgentSchema.parse({
    id: frame.conversation.agentId,
    ...frame.session,
    herdrSessionId: 'contract-session',
    workspaceId: 'contract-workspace',
    workspaceName: 'Synthetic',
    title: 'Synthetic',
    status: 'idle',
    focused: false,
    capabilities: frame.capabilities,
  });
}

describe('shared Python/mobile protocol contracts', () => {
  it.each(fixtures)('%s preserves every canonical conversation field', (_name, fixture) => {
    for (const frame of fixture.frames) {
      const conversation = conversationSchema.parse(frame.conversation);
      // safeParse.success alone would allow Zod to silently strip wire fields
      // or insert defaults that the bridge did not actually send.
      expect(conversation).toStrictEqual(frame.conversation);
      expect(conversation).toHaveProperty('providerSessionId', frame.session.providerSessionId);
      const agent = agentFor(frame);
      expect(agent.capabilities).toStrictEqual(frame.capabilities);
      expect(supportsRetuning(agent.provider, agent.capabilities)).toBe(frame.capabilities.supportsRetuning);
      expect(agentSession(agent)).toStrictEqual(frame.session);
      expect(conversationMatchesAgent(conversation, agent)).toBe(true);
      expect(commandSession({ precondition: frame.session })).toStrictEqual(frame.session);
      expect(sameAgentSession(agentSession(agent), frame.session)).toBe(true);
    }
  });

  it('rejects old conversation and command identities after an empty session replacement', () => {
    const [before, after] = copilot.frames;
    const oldConversation = conversationSchema.parse(before.conversation);
    const newConversation = conversationSchema.parse(after.conversation);
    const oldAgent = agentFor(before);
    const newAgent = agentFor(after);

    expect(oldAgent.id).toBe(newAgent.id);
    expect(oldAgent.paneId).toBe(newAgent.paneId);
    expect(newConversation.semantic).toBe(true);
    expect(newConversation.items).toStrictEqual([]);
    expect(newConversation.activeHumanRequest).toBeNull();
    expect(conversationMatchesAgent(oldConversation, newAgent)).toBe(false);
    expect(conversationMatchesAgent(newConversation, oldAgent)).toBe(false);
    expect(sameAgentSession(agentSession(oldAgent), agentSession(newAgent))).toBe(false);
    for (const command of commands.cases) {
      const bound = commandSession(command.request.payload);
      expect(sameAgentSession(bound, agentSession(oldAgent))).toBe(true);
      expect(sameAgentSession(bound, agentSession(newAgent))).toBe(false);
    }
  });

  it('distinguishes explicit null identity from an omitted legacy identity', () => {
    const frame = cursor.frames[0];
    const current = conversationSchema.parse(frame.conversation);
    const { providerSessionId: _sessionId, ...legacyWire } = frame.conversation;
    const legacy = conversationSchema.parse(legacyWire);
    expect(current.providerSessionId).toBeNull();
    expect(legacy).toStrictEqual(legacyWire);
    expect(legacy).not.toHaveProperty('providerSessionId');
    expect(conversationMatchesAgent(legacy, agentFor(frame))).toBe(false);
  });

  it('preserves structured questions, tool states, and explicit null fields', () => {
    const conversation = conversationSchema.parse(copilot.frames[0].conversation);
    const question = conversation.items.find((item) => item.kind === 'human_request');
    expect(question?.kind === 'human_request' && question.request)
      .toStrictEqual(conversation.activeHumanRequest);
    expect(question).not.toHaveProperty('resolved');
    expect(conversation.items.filter((item) => item.kind === 'tool_activity')).toStrictEqual([
      copilot.frames[0].conversation.items[2],
      copilot.frames[0].conversation.items[3],
    ]);
    expect(conversation.items[1].timestamp).toBeNull();
    expect(conversation.items[3]).toMatchObject({ detail: null, timestamp: 1767225600000 });
  });

  it('applies question defaults only when omitted, without changing explicit values', () => {
    const canonical = copilot.frames[0].conversation.activeHumanRequest!;
    const { allowCustomAnswer: _custom, multiSelect: _multi, ...withoutBooleans } = canonical;
    expect(humanRequestSchema.parse(withoutBooleans)).toStrictEqual(canonical);
    const { options: _options, ...withoutOptions } = canonical;
    expect(humanRequestSchema.parse(withoutOptions)).toStrictEqual({ ...canonical, options: [] });
    const explicit = { ...canonical, allowCustomAnswer: false, multiSelect: true };
    expect(humanRequestSchema.parse(explicit)).toStrictEqual(explicit);
    expect(humanRequestSchema.safeParse({ ...canonical, options: null }).success).toBe(false);
  });

  it.each(commands.cases)('preserves the durable $name response envelope', (fixture) => {
    const response = bridgeResponseSchema.parse(fixture.response);
    expect(response).toStrictEqual(fixture.response);
    expect(response.id).toBe(fixture.request.id);
    if (fixture.state === 'succeeded') {
      expect(response.ok).toBe(true);
      expect(response.payload).toStrictEqual({ accepted: true });
      expect(response).not.toHaveProperty('error');
    } else {
      expect(response.ok).toBe(false);
      expect(response.error?.code).toBe('COMMAND_UNCERTAIN');
      expect(response).not.toHaveProperty('payload');
    }
  });
});
