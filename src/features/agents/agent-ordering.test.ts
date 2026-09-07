import { remoteAgentSchema, type AgentWorkspace, type RemoteAgent } from '@/domain/herdr';
import { agentSections, compareAgents } from './agent-ordering';

function agent(id: string, workspaceId: string, lastOutputAt?: number | null, status = 'idle'): RemoteAgent {
  return remoteAgentSchema.parse({
    id, workspaceId, workspaceName: workspaceId, provider: 'copilot',
    herdrSessionId: 'default', paneId: id, title: id, focused: false,
    status, capabilities: {}, lastOutputAt,
  });
}

const spaces: AgentWorkspace[] = [
  { id: 'a', name: 'First', status: 'idle' },
  { id: 'b', name: 'Second', status: 'idle' },
];

describe('newest output ordering', () => {
  it('puts newer output ahead of status priority and alphabetical titles', () => {
    const rows = [agent('A', 'a', 100, 'blocked'), agent('Z', 'a', 300, 'working'), agent('B', 'a', 200, 'done')];
    expect([...rows].sort(compareAgents).map((row) => row.id)).toEqual(['Z', 'B', 'A']);
  });

  it('keeps deterministic status/title/ID ordering for unknown or equal activity', () => {
    const rows = [agent('z', 'a'), agent('a', 'a', null, 'done'), agent('b', 'a', undefined, 'blocked')];
    expect(rows.sort(compareAgents).map((row) => row.id)).toEqual(['b', 'a', 'z']);
    const equal = [agent('second', 'a', 100), agent('first', 'a', 100)].map((row) => ({ ...row, title: 'Same' }));
    expect(equal.sort(compareAgents).map((row) => row.id)).toEqual(['first', 'second']);
  });

  it('moves the newest-output workspace and its newest agent to the top', () => {
    const rows = Object.freeze([
      agent('old-a', 'a', 100), agent('old-b', 'b', 50), agent('new-b', 'b', 300),
    ]);
    const result = agentSections(rows, Object.freeze([...spaces]), null);
    expect(result.map((section) => section.space.id)).toEqual(['b', 'a']);
    expect(result[0].agents.map((row) => row.id)).toEqual(['new-b', 'old-b']);
    expect(rows.map((row) => row.id)).toEqual(['old-a', 'old-b', 'new-b']);
    expect(spaces.map((space) => space.id)).toEqual(['a', 'b']);
  });

  it('reacts to updated activity without moving the selected space or filter chips', () => {
    const rows = [agent('one', 'a', 100), agent('two', 'b', 200)];
    expect(agentSections(rows, spaces, null)[0].space.id).toBe('b');
    expect(agentSections([{ ...rows[0], lastOutputAt: 300 }, rows[1]], spaces, null)[0].space.id).toBe('a');
    expect(agentSections(rows, spaces, 'a').map((section) => section.space.id)).toEqual(['a']);
  });

  it('retains workspace order on ties and includes output from unassigned agents', () => {
    expect(agentSections([agent('b', 'b', 100), agent('a', 'a', 100)], spaces, null)
      .map((section) => section.space.id)).toEqual(['a', 'b']);
    expect(agentSections([agent('other', 'missing', 300), agent('a', 'a', 100)], spaces, null)
      .map((section) => section.space.id)).toEqual(['unassigned', 'a']);
    expect(agentSections([], spaces, null)).toEqual([]);
  });
});
