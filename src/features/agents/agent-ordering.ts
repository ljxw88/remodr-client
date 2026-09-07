import type { AgentWorkspace, RemoteAgent } from '@/domain/herdr';

export type AgentWorkspaceSection = {
  space: AgentWorkspace;
  agents: RemoteAgent[];
};

const STATUS_PRIORITY: Record<RemoteAgent['status'], number> = {
  blocked: 0, done: 1, working: 2, idle: 3, unknown: 4,
};

export function compareAgents(left: RemoteAgent, right: RemoteAgent): number {
  return (right.lastOutputAt ?? 0) - (left.lastOutputAt ?? 0)
    || STATUS_PRIORITY[left.status] - STATUS_PRIORITY[right.status]
    || left.title.localeCompare(right.title)
    || left.id.localeCompare(right.id);
}

export function agentSections(
  agents: readonly RemoteAgent[],
  spaces: readonly AgentWorkspace[],
  activeSpaceId: string | null,
): AgentWorkspaceSection[] {
  const visible = agents
    .filter((agent) => !activeSpaceId || agent.workspaceId === activeSpaceId)
    .sort(compareAgents);
  const sections: AgentWorkspaceSection[] = spaces
    .filter((space) => !activeSpaceId || space.id === activeSpaceId)
    .map((space) => ({ space, agents: visible.filter((agent) => agent.workspaceId === space.id) }));
  const known = new Set(spaces.map((space) => space.id));
  const unassigned = visible.filter((agent) => !known.has(agent.workspaceId));
  if (!activeSpaceId && unassigned.length) {
    sections.push({ space: { id: 'unassigned', name: 'Other', status: 'unknown' }, agents: unassigned });
  }
  // Stable ties retain the server's workspace order; filter chips never move.
  return sections.filter((section) => section.agents.length)
    .sort((left, right) => (right.agents[0].lastOutputAt ?? 0) - (left.agents[0].lastOutputAt ?? 0));
}
