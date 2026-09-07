import { agentSession, sameAgentSession } from './agent-session';
import type { AgentCompletion, RemoteAgent } from './herdr';

export function completionForSnapshot(
  previous: RemoteAgent | undefined,
  current: RemoteAgent,
  newId: () => string,
): AgentCompletion | undefined {
  const sameSession = sameAgentSession(agentSession(previous), agentSession(current));
  const receipt = sameSession ? previous?.completion : undefined;
  if (current.status !== 'done') return receipt;

  const revision = current.statusRevision ?? null;
  const priorRevision = sameSession ? previous?.statusRevision ?? receipt?.statusRevision : null;
  const counterReset = revision != null && priorRevision != null && revision < priorRevision;
  const transitioned = !sameSession || (previous?.observedStatus ?? previous?.status) !== 'done';
  const newCompletion = !receipt || (counterReset ? transitioned : (
    revision != null && receipt.statusRevision != null
      ? revision !== receipt.statusRevision
      : transitioned
  ));
  if (newCompletion) return { id: newId(), unread: true, statusRevision: revision };
  // Adopt newly available/reset counters without notifying twice for the same finish.
  return revision != null && receipt.statusRevision !== revision
    ? { ...receipt, statusRevision: revision }
    : receipt;
}

export function unreadCompletionCount(agents: readonly RemoteAgent[]): number {
  return agents.reduce((count, agent) => count + (agent.completion?.unread ? 1 : 0), 0);
}

export function unreadCompletionsBySpace(agents: readonly RemoteAgent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const agent of agents) {
    if (agent.completion?.unread) counts[agent.workspaceId] = (counts[agent.workspaceId] ?? 0) + 1;
  }
  return counts;
}
