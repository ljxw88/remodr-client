import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  conversationSchema,
  EMPTY_RUNTIME,
  runtimeStateSchema,
  type AgentConversation,
  type AgentStatus,
  type BridgeEvent,
  type BridgeHello,
  type HerdrConnectionState,
  type HerdrRuntimeState,
} from '@/domain/herdr';
import { HerdrBridgeTransport } from '@/services/herdr-bridge-transport';

const RUNTIME_CACHE_KEY = 'remote-workspace.herdr.runtime.v1';
const DRAFT_PREFIX = 'remote-workspace.herdr.draft.';

export type HerdrRepositoryState = {
  connection: HerdrConnectionState;
  runtime: HerdrRuntimeState;
  hello: BridgeHello | null;
  lastError: string | null;
  lastSemanticEvent: string | null;
};

const INITIAL_STATE: HerdrRepositoryState = {
  connection: 'disconnected',
  runtime: EMPTY_RUNTIME,
  hello: null,
  lastError: null,
  lastSemanticEvent: null,
};

const EMPTY_CONVERSATIONS = new Map<string, AgentConversation>();

export class HerdrRepository {
  private readonly transport = new HerdrBridgeTransport();
  private state: HerdrRepositoryState = INITIAL_STATE;
  private conversations = EMPTY_CONVERSATIONS;
  private listeners = new Set<() => void>();
  private conversationListeners = new Set<() => void>();
  private unsubscribeTransport: (() => void) | null = null;
  private sessionId: string | null = null;

  constructor() {
    this.unsubscribeTransport = this.transport.subscribe((event) => {
      void this.handleEvent(event);
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribeConversations = (listener: () => void): (() => void) => {
    this.conversationListeners.add(listener);
    return () => this.conversationListeners.delete(listener);
  };

  getSnapshot = (): HerdrRepositoryState => this.state;

  getConversation = (agentId: string): AgentConversation | null =>
    this.conversations.get(agentId) ?? null;

  async hydrate(): Promise<void> {
    const raw = await AsyncStorage.getItem(RUNTIME_CACHE_KEY);
    if (!raw) {
      return;
    }
    try {
      const runtime = runtimeStateSchema.parse(JSON.parse(raw));
      this.setState({
        ...this.state,
        runtime,
      });
    } catch (error) {
      console.warn('[HERDR_RUNTIME] Ignored invalid cached runtime', error);
    }
  }

  async connect(sessionId: string): Promise<void> {
    if (this.sessionId === sessionId && this.state.connection === 'connected') {
      return;
    }
    this.sessionId = sessionId;
    this.setConnection(this.state.runtime.agents.length > 0 ? 'reconnecting' : 'starting_bridge');
    try {
      const hello = await this.transport.start(sessionId);
      this.setState({
        ...this.state,
        connection: 'synchronizing',
        hello,
        lastError: hello.warning ?? null,
      });
      const runtime = runtimeStateSchema.parse(
        await this.transport.request('runtime.snapshot', {}),
      );
      await this.installRuntime(runtime);
      this.setState({
        ...this.state,
        connection: 'connected',
        hello,
        lastError: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not start Herdr.';
      this.setState({
        ...this.state,
        connection: 'error',
        lastError: message,
      });
      throw error;
    }
  }

  async retry(): Promise<void> {
    if (!this.sessionId) {
      throw new Error('No SSH session is available.');
    }
    await this.connect(this.sessionId);
  }

  async loadConversation(agentId: string): Promise<AgentConversation> {
    const conversation = conversationSchema.parse(
      await this.transport.request('agent.conversation', { agentId }),
    );
    this.conversations = new Map(this.conversations).set(agentId, conversation);
    this.conversationListeners.forEach((listener) => listener());
    return conversation;
  }

  async sendMessage(agentId: string, text: string): Promise<void> {
    const previous = this.conversations.get(agentId);
    if (previous) {
      this.conversations = new Map(this.conversations).set(
        agentId,
        appendOptimisticUserMessage(previous, text),
      );
      this.conversationListeners.forEach((listener) => listener());
    }
    try {
      await this.transport.request('agent.send_message', { agentId, text });
      this.updateAgentStatus(agentId, 'working');
      await this.saveDraft(agentId, '');
    } catch (error) {
      if (previous) {
        this.conversations = new Map(this.conversations).set(agentId, previous);
        this.conversationListeners.forEach((listener) => listener());
      }
      throw error;
    }
  }

  async answerHumanRequest(
    agentId: string,
    requestId: string,
    answer: { selectedOptionIds?: string[]; customText?: string | null },
  ): Promise<void> {
    await this.transport.request('human_request.answer', {
      agentId,
      requestId,
      answer,
    });
    this.updateAgentStatus(agentId, 'working');
  }

  async interrupt(agentId: string): Promise<void> {
    await this.transport.request('agent.interrupt', { agentId });
  }

  async loadDraft(agentId: string): Promise<string> {
    return (await AsyncStorage.getItem(DRAFT_PREFIX + agentId)) ?? '';
  }

  async saveDraft(agentId: string, text: string): Promise<void> {
    if (text) {
      await AsyncStorage.setItem(DRAFT_PREFIX + agentId, text);
    } else {
      await AsyncStorage.removeItem(DRAFT_PREFIX + agentId);
    }
  }

  diagnostics() {
    return {
      connection: this.state.connection,
      bridgeVersion: this.state.hello?.bridgeVersion,
      protocol: this.state.hello?.protocol,
      herdrVersion: this.state.runtime.herdrVersion,
      herdrSession: this.state.runtime.herdrSession,
      herdrSocket: this.state.runtime.socketPath,
      agents: this.state.runtime.agents.length,
      lastRuntimeEvent: this.state.runtime.lastRuntimeEvent,
      lastSemanticEvent: this.state.lastSemanticEvent,
      lastError: this.state.lastError,
    };
  }

  private async handleEvent(event: BridgeEvent): Promise<void> {
    if (event.event === 'runtime.snapshot') {
      const parsed = runtimeStateSchema.safeParse(event.data);
      if (parsed.success) {
        await this.installRuntime(parsed.data);
        this.setConnection('connected');
      }
      return;
    }
    if (event.event === 'conversation.changed') {
      const data = event.data as { agentId?: unknown };
      if (typeof data.agentId === 'string' && this.conversations.has(data.agentId)) {
        await this.loadConversation(data.agentId);
      }
      this.setState({
        ...this.state,
        lastSemanticEvent: event.event,
      });
      return;
    }
    if (event.event === 'connection.warning') {
      const data = event.data as { message?: unknown };
      this.setState({
        ...this.state,
        connection: 'reconnecting',
        lastError: typeof data.message === 'string' ? data.message : 'Connection interrupted.',
      });
    }
  }

  private async installRuntime(runtime: HerdrRuntimeState): Promise<void> {
    this.setState({
      ...this.state,
      runtime,
    });
    await AsyncStorage.setItem(RUNTIME_CACHE_KEY, JSON.stringify(runtime));
  }

  private updateAgentStatus(agentId: string, status: AgentStatus) {
    const runtime = reduceAgentStatus(this.state.runtime, agentId, status);
    this.setState({
      ...this.state,
      runtime,
    });
  }

  private setConnection(connection: HerdrConnectionState) {
    this.setState({
      ...this.state,
      connection,
    });
  }

  private setState(state: HerdrRepositoryState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }
}

export function reduceAgentStatus(
  runtime: HerdrRuntimeState,
  agentId: string,
  status: AgentStatus,
): HerdrRuntimeState {
  const index = runtime.agents.findIndex((agent) => agent.id === agentId);
  if (index < 0 || runtime.agents[index].status === status) {
    return runtime;
  }

  const agents = [...runtime.agents];
  agents[index] = { ...agents[index], status };
  return { ...runtime, agents };
}

export function appendOptimisticUserMessage(
  conversation: AgentConversation,
  text: string,
): AgentConversation {
  return {
    ...conversation,
    items: [
      ...conversation.items,
      {
        id: `local:${Date.now()}`,
        kind: 'user_message',
        text,
        timestamp: Date.now(),
      },
    ],
  };
}

export const herdrRepository = new HerdrRepository();
