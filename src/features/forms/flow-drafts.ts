import { useEffect, useSyncExternalStore } from 'react';

import type { Tuning } from '@/domain/agent-catalogue';
import type { AgentProvider, LaunchableAgentProvider } from '@/domain/herdr';
import { createId } from '@/utils/create-id';

export type NewAgentDraft = {
  kind: 'new-agent';
  deviceId: string;
  name: string;
  workspaceId: string;
  provider: LaunchableAgentProvider;
  tuning: Tuning;
  bypassPermissions: boolean;
};

export type NewSpaceDraft = {
  kind: 'new-space';
  deviceId: string;
  label: string;
  cwd: string;
};

export type AgentSettingsDraft = {
  kind: 'agent-settings';
  deviceId: string;
  agentId: string;
  provider: AgentProvider;
  initialTuning: Tuning;
  tuning: Tuning;
};

export type RenameAgentDraft = {
  kind: 'rename-agent';
  deviceId: string;
  agentId: string;
  initialName: string;
  name: string;
};

export type FlowDraft = NewAgentDraft | NewSpaceDraft | AgentSettingsDraft | RenameAgentDraft;

/** In-progress page state; selectors receive only its ID through route params. */
export class FlowDraftStore {
  private drafts = new Map<string, FlowDraft>();
  private leases = new Map<string, number>();
  private listeners = new Set<() => void>();

  create(draft: FlowDraft): string {
    const id = createId();
    this.drafts.set(id, draft);
    this.publish();
    return id;
  }

  get = (id: string | undefined): FlowDraft | undefined =>
    typeof id === 'string' ? this.drafts.get(id) : undefined;

  update(id: string, change: (draft: FlowDraft) => FlowDraft) {
    const current = this.drafts.get(id);
    if (!current) throw new Error('This form is no longer available.');
    const next = change(current);
    if (next.kind !== current.kind) throw new Error('A form cannot change its workflow type.');
    this.drafts.set(id, next);
    this.publish();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  retain(id: string): () => void {
    this.leases.set(id, (this.leases.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.leases.set(id, Math.max(0, (this.leases.get(id) ?? 1) - 1));
      // StrictMode immediately remounts effects. A live base/selector page
      // retains the draft before this cleanup; leaving the workflow removes it.
      queueMicrotask(() => {
        if ((this.leases.get(id) ?? 0) !== 0) return;
        this.leases.delete(id);
        if (this.drafts.delete(id)) this.publish();
      });
    };
  }

  discard(id: string) {
    if (this.drafts.delete(id)) this.publish();
  }

  private publish() {
    this.listeners.forEach((listener) => listener());
  }
}

export const flowDrafts = new FlowDraftStore();

export function useFlowDraft(flowId: string | undefined): FlowDraft | undefined {
  const draft = useSyncExternalStore(
    flowDrafts.subscribe,
    () => flowDrafts.get(flowId),
    () => undefined,
  );
  useEffect(() => {
    if (typeof flowId === 'string') return flowDrafts.retain(flowId);
  }, [flowId]);
  return draft;
}
