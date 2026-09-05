import type { ConversationItem } from '@/domain/herdr';
import {
  groupToolActivity,
  currentToolActivity,
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
      expect(toolActivitySummary(group)).toBe('Worked for 20m (2 tool calls)');
    }
  });

  it('does not fabricate a duration when timestamps are unavailable', () => {
    const grouped = groupToolActivity([
      { id: 't1', kind: 'tool_activity', title: 'Reading', state: 'completed' },
    ]);
    const group = grouped[0];
    if (group.kind === 'tool_group') {
      expect(toolActivitySummary(group)).toBe('Worked (1 tool call)');
    }
  });
});
