const DRAFT_PREFIX = 'remote-workspace.herdr.draft.';

export interface DraftStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface DraftRepository {
  loadDraft(agentId: string): Promise<string>;
  saveDraft(agentId: string, text: string): Promise<void>;
}

export class DraftStore implements DraftRepository {
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly storage: DraftStorage) {}

  async loadDraft(agentId: string): Promise<string> {
    // Keep the rejecting promise: a load must not disguise an unsuccessful save.
    await this.writes.get(agentId);
    return (await this.storage.getItem(DRAFT_PREFIX + agentId)) ?? '';
  }

  saveDraft(agentId: string, text: string): Promise<void> {
    const previous = this.writes.get(agentId) ?? Promise.resolve();
    const write = previous.catch(() => undefined)
      .then(() => text
        ? this.storage.setItem(DRAFT_PREFIX + agentId, text)
        : this.storage.removeItem(DRAFT_PREFIX + agentId));
    this.writes.set(agentId, write);
    void write.then(() => {
      if (this.writes.get(agentId) === write) this.writes.delete(agentId);
    }, () => undefined);
    return write;
  }
}
