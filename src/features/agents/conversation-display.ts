import type { AgentStatus, ConversationItem } from '@/domain/herdr';

export type ToolActivityItem = Extract<ConversationItem, { kind: 'tool_activity' }>;

export type ToolActivityGroup = {
  id: string;
  kind: 'tool_group';
  items: ToolActivityItem[];
};

export type ConversationDisplayItem = ConversationItem | ToolActivityGroup;

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

export function groupToolActivity(
  items: ConversationItem[],
): ConversationDisplayItem[] {
  const result: ConversationDisplayItem[] = [];
  let turn: ConversationItem[] = [];

  function flushTurn() {
    if (turn.length === 0) {
      return;
    }
    /**
     * A plan is state, not an event. The agent rewrites it as it goes, and
     * every rewrite arrives as its own item, so a turn that revised a plan
     * eight times used to stack eight copies of it down the transcript — the
     * first seven of them wrong. Only the last one is the plan.
     *
     * Per turn rather than per conversation, so a finished turn keeps the plan
     * it finished on instead of inheriting a later one.
     */
    const lastPlanIndex = turn.findLastIndex((item) => item.kind === 'todo_update');
    if (lastPlanIndex >= 0) {
      turn = turn.filter((item, index) => item.kind !== 'todo_update' || index === lastPlanIndex);
    }
    const tools = turn.filter(
      (item): item is ToolActivityItem => item.kind === 'tool_activity',
    );
    if (tools.length === 0) {
      result.push(...turn);
      turn = [];
      return;
    }
    const group: ToolActivityGroup = {
      id: `tools:${tools[0].id}:${tools[tools.length - 1].id}`,
      kind: 'tool_group',
      items: tools,
    };
    const lastToolIndex = turn.findLastIndex((item) => item.kind === 'tool_activity');
    turn.forEach((item, index) => {
      if (item.kind !== 'tool_activity') {
        result.push(item);
      }
      if (index === lastToolIndex) {
        result.push(group);
      }
    });
    turn = [];
  }

  for (const item of items) {
    if (item.kind === 'user_message') {
      flushTurn();
      result.push(item);
    } else {
      turn.push(item);
    }
  }
  flushTurn();
  return result;
}

export type PlanItem = Extract<ConversationItem, { kind: 'todo_update' }>['todos'][number];

/** How much of a plan is behind the agent, for the line that introduces it. */
export function planProgress(todos: PlanItem[]): { done: number; total: number } {
  return { done: todos.filter((todo) => todo.state === 'done').length, total: todos.length };
}

export type ToolActivitySummary = {
  /**
   * The whole collapsed line, minus any failures. Reads as the present tense
   * while the agent is still inside the group, because "worked for 20m" on
   * work that has not stopped is a claim about the past that is not true yet —
   * and because what the agent is doing now and what it has already done are
   * the two things a reader most needs told apart.
   */
  label: string;
  /** How many calls failed, so the row can say so in colour rather than hide it. */
  failed: number;
  /** Whether the agent is still inside these calls. */
  running: boolean;
};

export function toolActivitySummary(group: ToolActivityGroup): ToolActivitySummary {
  const count = group.items.length;
  const countLabel = `${count} tool ${count === 1 ? 'call' : 'calls'}`;
  const failed = group.items.filter((item) => item.state === 'failed').length;
  const running = group.items.some(
    (item) => item.state === 'running' || item.state === 'pending',
  );

  if (running) {
    return { label: `Working (${countLabel})`, failed, running };
  }
  const duration = toolActivityDuration(group.items);
  return {
    label: duration ? `Worked for ${duration} (${countLabel})` : `Worked (${countLabel})`,
    failed,
    running,
  };
}

function toolActivityDuration(items: ToolActivityItem[]): string | null {
  const timestamps = items
    .map((item) => parseTimestamp(item.timestamp))
    .filter((value): value is number => value != null);
  if (timestamps.length < 2) {
    return null;
  }
  const elapsedMs = Math.max(...timestamps) - Math.min(...timestamps);
  if (elapsedMs < 60_000) {
    return '<1m';
  }
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function parseTimestamp(timestamp: ConversationItem['timestamp']): number | null {
  if (typeof timestamp === 'number') {
    return timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  }
  if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}
