import type { ConversationItem } from '@/domain/herdr';

export type ToolActivityItem = Extract<ConversationItem, { kind: 'tool_activity' }>;

export type ToolActivityGroup = {
  id: string;
  kind: 'tool_group';
  items: ToolActivityItem[];
};

export type ConversationDisplayItem = ConversationItem | ToolActivityGroup;

export function groupToolActivity(
  items: ConversationItem[],
): ConversationDisplayItem[] {
  const result: ConversationDisplayItem[] = [];
  let turn: ConversationItem[] = [];

  function flushTurn() {
    if (turn.length === 0) {
      return;
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

export function toolActivitySummary(group: ToolActivityGroup): string {
  const count = group.items.length;
  const duration = toolActivityDuration(group.items);
  const countLabel = `${count} tool ${count === 1 ? 'call' : 'calls'}`;
  return duration ? `Worked for ${duration} (${countLabel})` : `Worked (${countLabel})`;
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
