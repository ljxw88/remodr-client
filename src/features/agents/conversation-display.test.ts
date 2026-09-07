import type { ConversationItem } from '@/domain/herdr';
import {
  groupToolActivity,
  currentToolActivity,
  planProgress,
  toolActivitySummary,
} from '@/features/agents/conversation-display';

describe('conversation display', () => {
  const staleTool: ConversationItem = {
    id: 'old-tool', kind: 'tool_activity', title: 'Reading files', state: 'running',
  };

  it('never treats a stale tool record as activity in a finished session', () => {
    expect(currentToolActivity([staleTool], 'done')).toBeUndefined();
    expect(currentToolActivity([staleTool], 'idle')).toBeUndefined();
  });

  it('does not reuse a running tool from an earlier turn', () => {
    expect(currentToolActivity([
      staleTool, { id: 'new-turn', kind: 'user_message', text: 'Next question' },
    ], 'working')).toBeUndefined();
    expect(currentToolActivity([
      { id: 'current-turn', kind: 'user_message', text: 'Read files' }, staleTool,
    ], 'working')).toBe(staleTool);
  });

  it('groups all tool activity in one user turn', () => {
    const items: ConversationItem[] = [
      { id: 'u1', kind: 'user_message', text: 'Fix it.' },
      { id: 'a1', kind: 'assistant_message', markdown: 'Checking.' },
      { id: 't1', kind: 'tool_activity', title: 'Reading', state: 'completed' },
      { id: 't2', kind: 'tool_activity', title: 'Editing', state: 'completed' },
      { id: 'a2', kind: 'assistant_message', markdown: 'Testing.' },
      { id: 't3', kind: 'tool_activity', title: 'Testing', state: 'running' },
      { id: 'a3', kind: 'assistant_message', markdown: 'Done.' },
      { id: 'u2', kind: 'user_message', text: 'Thanks.' },
    ];

    const grouped = groupToolActivity(items);

    expect(grouped.map((item) => item.kind)).toEqual([
      'user_message',
      'assistant_message',
      'assistant_message',
      'tool_group',
      'assistant_message',
      'user_message',
    ]);
    expect(grouped[3].kind === 'tool_group' && grouped[3].items).toHaveLength(3);
  });

  it('summarizes duration and tool count from reliable timestamps', () => {
    const grouped = groupToolActivity([
      {
        id: 't1',
        kind: 'tool_activity',
        title: 'Reading',
        state: 'completed',
        timestamp: '2026-09-02T12:00:00Z',
      },
      {
        id: 't2',
        kind: 'tool_activity',
        title: 'Testing',
        state: 'completed',
        timestamp: '2026-09-02T12:20:00Z',
      },
    ]);
    const group = grouped[0];
    expect(group.kind).toBe('tool_group');
    if (group.kind === 'tool_group') {
      expect(toolActivitySummary(group).label).toBe('Worked for 20m (2 tool calls)');
    }
  });

  it('does not fabricate a duration when timestamps are unavailable', () => {
    const grouped = groupToolActivity([
      { id: 't1', kind: 'tool_activity', title: 'Reading', state: 'completed' },
    ]);
    const group = grouped[0];
    if (group.kind === 'tool_group') {
      expect(toolActivitySummary(group).label).toBe('Worked (1 tool call)');
    }
  });
  it('says a group is still working rather than claiming a duration for it', () => {
    const grouped = groupToolActivity([
      { id: 't1', kind: 'tool_activity', title: 'Reading', state: 'completed',
        timestamp: '2026-09-02T12:00:00Z' },
      { id: 't2', kind: 'tool_activity', title: 'Testing', state: 'running',
        timestamp: '2026-09-02T12:20:00Z' },
    ]);
    const group = grouped[0];
    if (group.kind !== 'tool_group') throw new Error('expected a group');
    expect(toolActivitySummary(group)).toEqual({
      label: 'Working (2 tool calls)', failed: 0, running: true,
    });
  });

  it('counts failures, so a folded group cannot hide one', () => {
    const grouped = groupToolActivity([
      { id: 't1', kind: 'tool_activity', title: 'Reading', state: 'completed',
        timestamp: '2026-09-02T12:00:00Z' },
      { id: 't2', kind: 'tool_activity', title: 'Testing', state: 'failed',
        timestamp: '2026-09-02T12:20:00Z' },
      { id: 't3', kind: 'tool_activity', title: 'Building', state: 'failed',
        timestamp: '2026-09-02T12:20:00Z' },
    ]);
    const group = grouped[0];
    if (group.kind !== 'tool_group') throw new Error('expected a group');
    expect(toolActivitySummary(group)).toMatchObject({ failed: 2, running: false });
  });

  it('keeps only the last plan of a turn, and one per turn', () => {
    const plan = (id: string, text: string): ConversationItem => ({
      id, kind: 'todo_update', todos: [{ text, state: 'pending' }],
    });
    const display = groupToolActivity([
      { id: 'u1', kind: 'user_message', text: 'go' },
      plan('p1', 'first draft'),
      plan('p2', 'second draft'),
      plan('p3', 'settled'),
      { id: 'u2', kind: 'user_message', text: 'again' },
      plan('p4', 'next turn'),
    ]);
    expect(display.filter((item) => item.kind === 'todo_update').map((item) => item.id))
      .toEqual(['p3', 'p4']);
  });

  it('counts a plan\'s finished steps for the line that introduces it', () => {
    expect(planProgress([
      { text: 'a', state: 'done' },
      { text: 'b', state: 'in_progress' },
      { text: 'c', state: 'blocked' },
      { text: 'd', state: 'pending' },
    ])).toEqual({ done: 1, total: 4 });
    expect(planProgress([])).toEqual({ done: 0, total: 0 });
  });
});
