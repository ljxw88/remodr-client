import type { ConversationItem } from '@/domain/herdr';
import {
  conversationActivity,
  conversationTranscript,
  currentToolActivity,
  planProgress,
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

  it('separates tool history from the transcript without changing the source', () => {
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

    const transcript = conversationTranscript(items);

    expect(transcript.map((item) => item.kind)).toEqual([
      'user_message',
      'assistant_message',
      'assistant_message',
      'assistant_message',
      'user_message',
    ]);
    expect(conversationActivity(items).tools.map((item) => item.id)).toEqual(['t3', 't2', 't1']);
    expect(items.map((item) => item.id)).toEqual(['u1', 'a1', 't1', 't2', 'a2', 't3', 'a3', 'u2']);
  });

  it('filters legacy groups and plans before virtualization', () => {
    expect(conversationTranscript([
      { id: 'group', kind: 'tool_group', items: [staleTool] },
      staleTool,
      { id: 'plan', kind: 'todo_update', todos: [] },
    ])).toEqual([]);
  });

  it('keeps only the latest plan across turns, including an empty replacement', () => {
    const plan = (id: string, text: string): ConversationItem => ({
      id, kind: 'todo_update', todos: [{ text, state: 'pending' }],
    });
    const items: ConversationItem[] = [
      { id: 'u1', kind: 'user_message', text: 'go' },
      plan('p1', 'first draft'),
      plan('p2', 'second draft'),
      plan('p3', 'settled'),
      { id: 'u2', kind: 'user_message', text: 'again' },
      plan('p4', 'next turn'),
    ];
    expect(conversationActivity(items).todos).toEqual([{ text: 'next turn', state: 'pending' }]);
    expect(conversationActivity([...items, { id: 'clear', kind: 'todo_update', todos: [] }]).todos).toEqual([]);
    expect(conversationActivity([staleTool]).todos).toEqual([]);
  });

  it('counts a plan\'s finished steps for the line that introduces it', () => {
    expect(planProgress([
      { text: 'a', state: 'done' },
      { text: 'b', state: 'in_progress' },
      { text: 'c', state: 'blocked' },
      { text: 'cancelled', state: 'cancelled' },
      { text: 'd', state: 'pending' },
    ])).toEqual({ done: 1, total: 5 });
    expect(planProgress([])).toEqual({ done: 0, total: 0 });
  });
});
