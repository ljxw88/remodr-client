import { z } from 'zod';

import type { AgentConversation, RemoteAgent } from '@/domain/herdr';

const sessionSchema = z.object({
  provider: z.string().min(1),
  paneId: z.string().min(1),
  providerSessionId: z.string().min(1).nullable(),
});
export type AgentSession = z.infer<typeof sessionSchema>;

export function agentSession(agent: RemoteAgent | undefined): AgentSession | undefined {
  return agent && {
    provider: agent.provider,
    paneId: agent.paneId,
    providerSessionId: agent.providerSessionId ?? null,
  };
}

export function sameAgentSession(left: AgentSession | undefined, right: AgentSession | undefined): boolean {
  return !!left && !!right && left.provider === right.provider
    && left.paneId === right.paneId && left.providerSessionId === right.providerSessionId;
}

export function commandSession(payload: Record<string, unknown>): AgentSession | undefined {
  const parsed = sessionSchema.safeParse(payload.precondition);
  return parsed.success ? parsed.data : undefined;
}

export function conversationMatchesAgent(conversation: AgentConversation, agent: RemoteAgent): boolean {
  return conversation.agentId === agent.id && conversation.provider === agent.provider
    && conversation.providerSessionId !== undefined
    && conversation.providerSessionId === (agent.providerSessionId ?? null);
}
