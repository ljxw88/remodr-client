import { useEffect, useMemo, useSyncExternalStore } from 'react';

import type { DraftRepository } from '@/services/draft-store';

type Snapshot = { draft: string; error: string | null };
const EMPTY: Snapshot = { draft: '', error: null };
const sessions = new WeakMap<DraftRepository, Map<string, DraftSession>>();

export interface DraftSendToken {
  readonly agentId: string;
  readonly text: string;
  readonly revision: number;
  /** Call only after durable enqueue, even if the screen has already unmounted. */
  complete(): Promise<void>;
  cancel(): void;
}

// A pending send keeps its session alive across navigation/remounts so its
// acknowledgement cannot clear edits made by a newer screen for the same agent.
class DraftSession {
  private snapshot: Snapshot = EMPTY;
  private listeners = new Set<() => void>();
  private revision = 0;
  private restored = false;
  private dirty = false;
  private loading: Promise<void> | null = null;
  private saving: { revision: number; promise: Promise<void> } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private users = 0;
  private sends = 0;
  private errorKind: 'restore' | 'save' | null = null;

  constructor(
    private readonly repository: DraftRepository,
    readonly agentId: string,
    private readonly release: () => void,
  ) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private collect() {
    if (!this.users && !this.sends && !this.dirty && !this.loading && !this.saving && !this.snapshot.error) {
      this.release();
    }
  }

  attach = () => {
    this.users++;
    void (this.dirty ? this.flush() : this.restore()).catch(() => undefined);
    return () => {
      // Read mutable session state, not the render that installed this cleanup.
      void this.flush().catch(() => undefined);
      this.users--;
      this.collect();
    };
  };

  private restore(): Promise<void> {
    if (this.restored) return Promise.resolve();
    if (this.loading) return this.loading;
    const revision = this.revision;
    this.loading = this.repository.loadDraft(this.agentId).then((draft) => {
      this.restored = true;
      if (this.errorKind === 'restore') {
        this.errorKind = null;
        this.publish({ error: null });
      }
      if (this.revision === revision && !this.dirty) this.publish({ draft });
    }, (error: unknown) => {
      // An explicit successful send may have superseded this pending read.
      if (!this.restored) {
        this.errorKind = 'restore';
        this.publish({ error: 'Could not restore the saved draft. Existing saved text has not been replaced.' });
        console.warn('[CONVERSATION] Could not load draft', error);
        throw error;
      }
    }).finally(() => {
      this.loading = null;
      this.collect();
    });
    return this.loading;
  }

  changeDraft = (draft: string) => {
    if (draft === this.snapshot.draft) return;
    this.revision++;
    this.dirty = true;
    this.publish({ draft });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => undefined);
    }, 250);
  };

  flush = async (): Promise<void> => {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty) return;
    // Never replace unread disk contents following a failed restore.
    if (!this.restored) await this.restore();
    if (!this.dirty) return;
    const revision = this.revision;
    if (this.saving?.revision === revision) return this.saving.promise;
    const promise = this.repository.saveDraft(this.agentId, this.snapshot.draft).then(() => {
      if (revision === this.revision) {
        this.dirty = false;
        if (this.errorKind === 'save') {
          this.errorKind = null;
          this.publish({ error: null });
        }
      }
    }, (error: unknown) => {
      this.errorKind = 'save';
      this.publish({ error: 'Could not save the draft. Changes are kept in memory; saving will retry when you edit or leave this screen.' });
      console.warn('[CONVERSATION] Could not save draft', error);
      throw error;
    }).finally(() => {
      if (this.saving?.promise === promise) this.saving = null;
      this.collect();
    });
    this.saving = { revision, promise };
    return promise;
  };

  captureSend = (): DraftSendToken => {
    const revision = this.revision;
    const text = this.snapshot.draft.trim();
    this.sends++;
    let consumed = false;
    const cancel = () => {
      if (consumed) return;
      consumed = true;
      this.sends--;
      this.collect();
    };
    return {
      agentId: this.agentId,
      text,
      revision,
      cancel,
      complete: async () => {
        if (consumed) return;
        consumed = true;
        try {
          if (revision !== this.revision) return;
          this.revision++;
          this.restored = true;
          this.dirty = true;
          this.errorKind = null;
          this.publish({ draft: '', error: null });
          // Clear immediately and durably, not through the input debounce.
          await this.flush();
        } finally {
          this.sends--;
          this.collect();
        }
      },
    };
  };
}

function sessionFor(repository: DraftRepository, agentId: string) {
  let drafts = sessions.get(repository);
  if (!drafts) {
    drafts = new Map();
    sessions.set(repository, drafts);
  }
  let session = drafts.get(agentId);
  if (!session) {
    const entries = drafts;
    session = new DraftSession(repository, agentId, () => {
      if (entries.get(agentId) === session) entries.delete(agentId);
    });
    drafts.set(agentId, session);
  }
  return session;
}

const emptySubscribe = () => () => {};
const emptySnapshot = () => EMPTY;

export function usePersistedDraft({
  agentId,
  repository,
  focused,
  foreground,
}: {
  agentId?: string;
  repository: DraftRepository;
  focused: boolean;
  foreground: boolean;
}) {
  const session = useMemo(
    () => agentId ? sessionFor(repository, agentId) : null,
    [agentId, repository],
  );
  const snapshot = useSyncExternalStore(
    session?.subscribe ?? emptySubscribe,
    session?.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
  useEffect(() => session?.attach(), [session]);
  useEffect(() => {
    if (!focused || !foreground) void session?.flush().catch(() => undefined);
  }, [session, focused, foreground]);

  return {
    ...snapshot,
    changeDraft: (text: string) => session?.changeDraft(text),
    captureSend: () => session?.captureSend(),
  };
}
