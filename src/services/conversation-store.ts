import type AsyncStorage from '@react-native-async-storage/async-storage';

import { agentSession, conversationMatchesAgent, sameAgentSession } from '@/domain/agent-session';
import { connectionErrorCode, ConnectionError } from '@/domain/connection-error';
import { conversationSchema, type AgentConversation, type RemoteAgent } from '@/domain/herdr';

const CACHE_PREFIX = 'remote-workspace.herdr.conversation.';
type ConversationStorage = Pick<typeof AsyncStorage, 'getItem' | 'setItem' | 'removeItem'>;

export interface ConversationRequest {
  read(): Promise<unknown>;
  assertAttached(): void;
  refreshIdentity(): Promise<void>;
}

export interface ConversationSource {
  getAgent(agentId: string): RemoteAgent | undefined;
  open(agentId: string): ConversationRequest;
}

/** Owns authoritative transcripts; local delivery overlays remain outside this store. */
export class ConversationStore {
  private conversations = new Map<string, AgentConversation>();
  private listeners = new Set<() => void>();
  private refreshing = new Map<string, Promise<AgentConversation>>();
  private restoring = new Map<string, Promise<void>>();
  private epochs = new Map<string, number>();
  private writes = new Map<string, Promise<void>>();
  private cacheVersions = new Map<string, { epoch: number; serialized: string }>();

  constructor(
    private readonly source: ConversationSource,
    private readonly storage: ConversationStorage,
    // Durable consumers run once per coalesced read. Their failures must propagate.
    private readonly onRead: (conversation: AgentConversation) => Promise<void>,
  ) {}

  get = (agentId: string): AgentConversation | null => this.conversations.get(agentId) ?? null;
  getSnapshot = (): ReadonlyMap<string, AgentConversation> => this.conversations;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** A replacement attachment must not join an obsolete request, but retains offline history. */
  detach(agentIds: readonly string[]) {
    for (const id of agentIds) this.refreshing.delete(id);
  }

  /** The owner installs the new runtime before notifying this store. */
  reconcileAgents(previous: readonly RemoteAgent[], current: readonly RemoteAgent[]): Promise<void> {
    const currentAgents = new Map(current.map((agent) => [agent.id, agent]));
    const invalidated = new Set<string>();
    for (const agent of previous) {
      if (!sameAgentSession(agentSession(agent), agentSession(currentAgents.get(agent.id)))) {
        invalidated.add(agent.id);
      }
    }
    for (const agent of current) {
      const cached = this.get(agent.id);
      if (cached && !conversationMatchesAgent(cached, agent)) invalidated.add(agent.id);
    }
    const removals: Promise<void>[] = [];
    if (invalidated.size) {
      const next = new Map(this.conversations);
      for (const id of invalidated) {
        const epoch = this.epoch(id) + 1;
        this.epochs.set(id, epoch);
        next.delete(id);
        this.restoring.delete(id);
        removals.push(this.persist(id, null, epoch));
      }
      this.conversations = next;
      this.publish();
    }
    return Promise.all(removals).then(() => undefined);
  }

  load(agentId: string): Promise<AgentConversation> {
    const existing = this.refreshing.get(agentId);
    if (existing) return existing;
    const attempt = this.loadOnce(agentId).catch((error: unknown) => {
      // A rotation may be discovered by the very request reading the transcript.
      if (connectionErrorCode(error) === 'CONVERSATION_SESSION_CHANGED') return this.loadOnce(agentId);
      throw error;
    }).finally(() => {
      if (this.refreshing.get(agentId) === attempt) this.refreshing.delete(agentId);
    });
    this.refreshing.set(agentId, attempt);
    return attempt;
  }

  restore(agentId: string): Promise<void> {
    if (this.conversations.has(agentId)) return Promise.resolve();
    const active = this.restoring.get(agentId);
    if (active) return active;
    const epoch = this.epoch(agentId);
    const attempt = (async () => {
      let cached: string | null;
      try {
        cached = await this.storage.getItem(CACHE_PREFIX + agentId);
      } catch (error) {
        console.warn('[CONVERSATION_CACHE] Could not read cached transcript', agentId, error);
        return;
      }
      if (!cached || epoch !== this.epoch(agentId) || this.conversations.has(agentId)) return;
      let value: unknown;
      try {
        value = JSON.parse(cached);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        console.warn('[CONVERSATION_CACHE] Discarding malformed cached transcript', agentId);
        await this.persist(agentId, null, epoch);
        return;
      }
      const parsed = conversationSchema.safeParse(value);
      if (!parsed.success || parsed.data.agentId !== agentId) {
        console.warn('[CONVERSATION_CACHE] Discarding invalid or mismatched cached transcript', agentId);
        await this.persist(agentId, null, epoch);
        return;
      }
      const conversation = parsed.data;
      const agent = this.source.getAgent(agentId);
      if (agent && !conversationMatchesAgent(conversation, agent)) {
        await this.persist(agentId, null, epoch);
        return;
      }
      this.conversations = new Map(this.conversations).set(agentId, conversation);
      this.cacheVersions.set(agentId, { epoch, serialized: JSON.stringify(conversation) });
      this.publish();
    })().finally(() => {
      if (this.restoring.get(agentId) === attempt) this.restoring.delete(agentId);
    });
    this.restoring.set(agentId, attempt);
    return attempt;
  }

  private async loadOnce(agentId: string): Promise<AgentConversation> {
    await this.restore(agentId);
    const request = this.source.open(agentId);
    const requestedAgent = this.source.getAgent(agentId);
    if (!requestedAgent) throw new Error('That agent is no longer available.');
    const epoch = this.epoch(agentId);
    const assertCurrent = () => {
      request.assertAttached();
      if (epoch !== this.epoch(agentId)
        || !sameAgentSession(agentSession(requestedAgent), agentSession(this.source.getAgent(agentId)))) {
        throw new ConnectionError('CONVERSATION_SESSION_CHANGED', 'The agent session changed. Refreshing its conversation.');
      }
    };
    const raw = await request.read();
    assertCurrent();
    const parsed = conversationSchema.parse(raw);
    if (parsed.agentId !== agentId || parsed.provider !== requestedAgent.provider) {
      throw new ConnectionError('INVALID_RESPONSE', 'Conversation belongs to a different agent.');
    }
    const conversation = {
      ...parsed,
      providerSessionId: parsed.providerSessionId === undefined
        ? requestedAgent.providerSessionId ?? null : parsed.providerSessionId,
    };
    if (!conversationMatchesAgent(conversation, requestedAgent)) {
      await request.refreshIdentity();
      throw new ConnectionError('CONVERSATION_SESSION_CHANGED', 'The bridge read a different session. Refreshing its identity.');
    }
    const serialized = JSON.stringify(conversation);
    if (serialized !== JSON.stringify(this.get(agentId))) {
      this.conversations = new Map(this.conversations).set(agentId, conversation);
      this.publish();
    }
    const cachedVersion = this.cacheVersions.get(agentId);
    if (cachedVersion?.epoch !== epoch || cachedVersion.serialized !== serialized) {
      // Rebuildable storage cannot delay live publication or durable consumers.
      void this.persist(agentId, conversation, epoch);
    }
    await this.onRead(conversation);
    assertCurrent();
    return conversation;
  }

  private epoch(agentId: string): number {
    return this.epochs.get(agentId) ?? 0;
  }

  private persist(agentId: string, conversation: AgentConversation | null, epoch: number): Promise<void> {
    const version = conversation ? { epoch, serialized: JSON.stringify(conversation) } : undefined;
    if (version) this.cacheVersions.set(agentId, version);
    else this.cacheVersions.delete(agentId);
    const operation = (this.writes.get(agentId) ?? Promise.resolve()).then(async () => {
      if (epoch !== this.epoch(agentId)) return;
      if (version) await this.storage.setItem(CACHE_PREFIX + agentId, version.serialized);
      else await this.storage.removeItem(CACHE_PREFIX + agentId);
    }).catch((error: unknown) => {
      if (version && this.cacheVersions.get(agentId) === version) this.cacheVersions.delete(agentId);
      console.warn('[CONVERSATION_CACHE] Could not persist cached transcript', agentId, error);
    });
    // Serialize evictions with writes so an old response cannot undo invalidation.
    this.writes.set(agentId, operation);
    void operation.then(() => {
      if (this.writes.get(agentId) === operation) this.writes.delete(agentId);
    });
    return operation;
  }

  private publish() {
    this.listeners.forEach((listener) => listener());
  }
}
