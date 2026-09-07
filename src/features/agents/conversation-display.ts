import type { AgentStatus, ConversationItem } from '@/domain/herdr';

export type ToolActivityItem = Extract<ConversationItem, { kind: 'tool_activity' }>;

export type ToolActivityGroup = {
  id: string;
  kind: 'tool_group';
  items: ToolActivityItem[];
};

export type ConversationDisplayItem = ConversationItem | ToolActivityGroup;

export type TranscriptItem = Exclude<ConversationItem, { kind: 'tool_activity' | 'todo_update' }>;

/** Filter before virtualization so activity leaves neither rows nor spacing. */
export function conversationTranscript(items: ConversationDisplayItem[]): TranscriptItem[] {
  return items.filter((item): item is TranscriptItem =>
    item.kind !== 'tool_activity' && item.kind !== 'todo_update' && item.kind !== 'tool_group',
  );
}

export function conversationActivity(items: ConversationItem[]) {
  const tools = items.filter((item): item is ToolActivityItem => item.kind === 'tool_activity').reverse();
  const plan = items.findLast((item) => item.kind === 'todo_update');
  return { tools, todos: plan?.kind === 'todo_update' ? plan.todos : [] };
}

export function currentToolActivity(
  items: ConversationItem[], status: AgentStatus | undefined,
): ToolActivityItem | undefined {
  if (status !== 'working') return undefined;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index];
    if (item.kind === 'user_message') return undefined;
    if (item.kind === 'tool_activity' && item.state === 'running') return item;
  }
  return undefined;
}

export type PlanItem = Extract<ConversationItem, { kind: 'todo_update' }>['todos'][number];

/** How much of a plan is behind the agent, for the line that introduces it. */
export function planProgress(todos: PlanItem[]): { done: number; total: number } {
  return { done: todos.filter((todo) => todo.state === 'done').length, total: todos.length };
}
