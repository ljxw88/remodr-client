import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  closeSpaceInputSchema,
  closeSpaceResultSchema,
  agentMutationResultSchema,
  createAgentInputSchema,
  createAgentResultSchema,
  renameAgentInputSchema,
  retuneAgentInputSchema,
  createSpaceInputSchema,
  createSpaceResultSchema,
  EMPTY_RUNTIME,
  runtimeStateSchema,
  totalDeviceAgentCount,
  type AgentConversation,
  type AgentCompletion,
  type AgentStatus,
  type BridgeEvent,
  type BridgeHello,
  type CloseSpaceResult,
  type AgentMutationResult,
  type CreateAgentInput,
  type CreateAgentResult,
  type RetuneAgentInput,
  type CreateSpaceInput,
  type CreateSpaceResult,
  type DeviceAgentCounts,
  type HerdrConnectionState,
  type HerdrRuntimeState,
  type RemoteAgent,
} from '@/domain/herdr';
import { agentSession, commandSession, conversationMatchesAgent, sameAgentSession, type AgentSession } from '@/domain/agent-session';
import { retuningUnavailableReason } from '@/domain/agent-capabilities';
import { HerdrBridgeTransport } from '@/services/herdr-bridge-transport';
import { classifyConnectionError, ConnectionError } from '@/domain/connection-error';
import { CommandOutbox, type PendingCommand } from '@/services/command-outbox';
import { CommandDispatcher, type CommandAttachment } from '@/services/command-dispatcher';
import { DraftStore } from '@/services/draft-store';
import { ConversationStore, type ConversationRequest } from '@/services/conversation-store';
import { completionForSnapshot } from '@/domain/agent-completion';
import { createId } from '@/utils/create-id';

const RUNTIME_CACHE_KEY = 'remote-workspace.herdr.runtimes.v2';

/** Everything the app knows about one device's Herdr runtime. */
export type DeviceRuntimeState = {
  deviceId: string;
  connection: HerdrConnectionState;
  runtime: HerdrRuntimeState;
  hello: BridgeHello | null;
  lastError: string | null;
};

/**
 * `connection`, `runtime`, `hello` and `lastError` mirror the selected device,
 * so screens that only care about the current device keep reading one runtime.
 */
export type HerdrRepositoryState = {
  connection: HerdrConnectionState;
  selectedDeviceId: string | null;
  runtime: HerdrRuntimeState;
  devices: Record<string, DeviceRuntimeState>;
  agentCountsByDevice: DeviceAgentCounts;
  hello: BridgeHello | null;
  lastError: string | null;
  lastSemanticEvent: string | null;
};

type DeviceConnection = {
  deviceId: string;
  sessionId: string | null;
  transport: HerdrBridgeTransport;
  unsubscribe: () => void;
  state: DeviceRuntimeState;
  generation: number;
  runtimeGeneration: number;
};

const EMPTY_CONVERSATIONS = new Map<string, AgentConversation>();

function emptyDeviceState(deviceId: string): DeviceRuntimeState {
  return {
    deviceId,
    connection: 'disconnected',
    runtime: EMPTY_RUNTIME,
    hello: null,
    lastError: null,
  };
}

function durableRuntime(runtime: HerdrRuntimeState): Omit<HerdrRuntimeState, 'runtimeRevision'> {
  const { runtimeRevision: _runtimeRevision, agents, ...rest } = runtime;
  return {
    ...rest,
    agents: agents.map(({ lastOutputAt: _lastOutputAt, ...agent }) => agent),
  };
}

export class HerdrRepository {
  private devices = new Map<string, DeviceConnection>();
  private selectedDeviceId: string | null = null;
  private lastSemanticEvent: string | null = null;
  private state: HerdrRepositoryState = {
    connection: 'disconnected',
    selectedDeviceId: null,
    runtime: EMPTY_RUNTIME,
    devices: {},
    agentCountsByDevice: {},
    hello: null,
    lastError: null,
    lastSemanticEvent: null,
  };
  private conversations = EMPTY_CONVERSATIONS;
  private listeners = new Set<() => void>();
  private conversationListeners = new Set<() => void>();
  /** Agent IDs are hashed, so ownership has to be indexed from snapshots. */
  private agentIndex = new Map<string, string>();
  private hydrateAttempt: Promise<void> | null = null;
  private hydrated = false;
  private connectionObserver: ((deviceId: string, error: unknown) => void) | null = null;
  private reconnectHandler: ((deviceId: string) => Promise<boolean>) | null = null;
  private readonly transcripts: ConversationStore;
  private readonly dispatcher: CommandDispatcher;
  private writingRuntimes: Promise<void> = Promise.resolve();
  private readonly drafts = new DraftStore(AsyncStorage);

  constructor(
    private readonly createTransport: () => HerdrBridgeTransport = () =>
      new HerdrBridgeTransport(),
    outbox = new CommandOutbox(),
  ) {
    this.transcripts = new ConversationStore({
      getAgent: (agentId) => this.currentAgent(agentId),
      open: (agentId) => this.openConversationRequest(agentId),
    }, AsyncStorage, (conversation) => this.dispatcher.reconcile(conversation));
    this.dispatcher = new CommandDispatcher(outbox, {
      open: (deviceId) => this.openCommandAttachment(deviceId),
      isConnected: (deviceId) => this.isDeviceConnected(deviceId),
      getAgent: (agentId) => this.currentAgent(agentId),
      getConversation: (agentId) => this.transcripts.get(agentId),
      readConversation: (agentId) => this.loadConversation(agentId),
      reconnect: (deviceId) => this.reconnectHandler?.(deviceId),
      onSent: (agentId) => this.updateAgentStatus(agentId, 'working'),
      onConnectionError: (deviceId, error) => this.connectionObserver?.(deviceId, error),
      onQueueError: (deviceId) => {
        if (this.devices.has(deviceId)) {
          this.setDeviceState(deviceId, { lastError: 'Could not update the saved send queue.' });
        }
      },
    });
    this.transcripts.subscribe(() => this.publishConversations());
    this.dispatcher.subscribe(() => this.publishConversations());
  }

  setReconnectHandler(handler: (deviceId: string) => Promise<boolean>) {
    this.reconnectHandler = handler;
  }

  setConnectionObserver(handler: (deviceId: string, error: unknown) => void) {
    this.connectionObserver = handler;
  }

  getPendingCommands = () => this.dispatcher.getSnapshot();
  subscribeCommands = (listener: () => void) => this.dispatcher.subscribe(listener);

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

  getCompletion = (agentId: string): AgentCompletion | undefined =>
    this.currentAgent(agentId)?.completion;

  async markCompletionRead(agentId: string, expectedId: string): Promise<void> {
    const agent = this.currentAgent(agentId);
    const conversation = this.transcripts.get(agentId);
    if (!agent || !conversation || !conversationMatchesAgent(conversation, agent)) return;
    if (!this.setCompletionUnread(agentId, expectedId, false)) return;
    try {
      await this.persistRuntimes();
    } catch (error) {
      // A failed old acknowledgement must not overwrite a newer completion.
      this.setCompletionUnread(agentId, expectedId, true);
      throw error;
    }
  }

  private setCompletionUnread(agentId: string, expectedId: string, unread: boolean): boolean {
    const deviceId = this.deviceIdForAgent(agentId);
    const device = deviceId ? this.devices.get(deviceId) : undefined;
    if (!device) return false;
    let changed = false;
    const agents = device.state.runtime.agents.map((agent) => {
      if (agent.id !== agentId || agent.completion?.id !== expectedId || agent.completion.unread === unread) return agent;
      changed = true;
      return { ...agent, completion: { ...agent.completion, unread } };
    });
    if (changed) this.setDeviceState(device.deviceId, { runtime: { ...device.state.runtime, agents } });
    return changed;
  }

  /**
   * The device that owns an agent, or null when nothing has claimed it yet.
   *
   * Agent IDs are hashed from session, device, and pane, so ownership cannot be
   * parsed back out and has to be read from the index. Screens need this to
   * follow the owning device's connection: a cached runtime can name an agent
   * long before its transport is up, and a conversation fetched in that window
   * fails.
   */
  deviceIdForAgent = (agentId: string): string | null =>
    this.agentIndex.get(agentId) ?? null;

  /** Pure view state. Selecting a device never reconnects anything. */
  selectDevice(deviceId: string) {
    if (this.selectedDeviceId === deviceId) {
      return;
    }
    this.selectedDeviceId = deviceId;
    this.publish();
  }

  async hydrate(): Promise<void> {
    if (this.hydrated) {
      return;
    }
    if (this.hydrateAttempt) {
      return this.hydrateAttempt;
    }
    const attempt = Promise.all([this.hydrateFromStorage(), this.dispatcher.hydrate()]).then(() => {
      this.hydrated = true;
      this.publishConversations();
    }).finally(() => {
      if (this.hydrateAttempt === attempt) {
        this.hydrateAttempt = null;
      }
    });
    this.hydrateAttempt = attempt;
    return attempt;
  }

  private async hydrateFromStorage(): Promise<void> {
    const raw = await AsyncStorage.getItem(RUNTIME_CACHE_KEY);
    if (!raw) {
      return;
    }
    try {
      const cached = JSON.parse(raw) as Record<string, unknown>;
      for (const [deviceId, value] of Object.entries(cached)) {
        const parsed = runtimeStateSchema.safeParse(value);
        const device = this.deviceConnection(deviceId);
        if (parsed.success && device.state.runtime === EMPTY_RUNTIME) {
          device.state = { ...device.state, runtime: parsed.data };
        }
      }
      this.reindexAgents();
      this.publish();
    } catch (error) {
      console.warn('[HERDR_RUNTIME] Ignored invalid cached runtimes', error);
    }
  }

  private deviceConnection(deviceId: string): DeviceConnection {
    const existing = this.devices.get(deviceId);
    if (existing) {
      return existing;
    }
    const transport = this.createTransport();
    const connection: DeviceConnection = {
      deviceId,
      sessionId: null,
      transport,
      unsubscribe: () => undefined,
      state: emptyDeviceState(deviceId),
      generation: 0,
      runtimeGeneration: -1,
    };
    connection.unsubscribe = transport.subscribe((event) => {
      void this.handleEvent(deviceId, event).catch((error) => {
        console.warn('[HERDR_RUNTIME] Could not apply bridge event', error);
      });
    });
    this.devices.set(deviceId, connection);
    return connection;
  }

  /**
   * Starts or reuses this device's bridge. Other devices keep their bridges and
   * runtimes, so switching back to them needs no work.
   */
  async connect(sessionId: string, deviceId: string): Promise<void> {
    const device = this.deviceConnection(deviceId);
    if (device.sessionId === sessionId && device.state.connection === 'connected') {
      return;
    }
    device.sessionId = sessionId;
    const generation = ++device.generation;
    this.setDeviceState(deviceId, {
      connection: device.state.runtime.agents.length > 0 ? 'reconnecting' : 'starting_bridge',
    });
    try {
      const hello = await device.transport.start(sessionId);
      if (device.generation !== generation) throw new ConnectionError('ERR_BRIDGE_CLOSED', 'Connection was replaced.');
      this.setDeviceState(deviceId, {
        connection: 'synchronizing',
        hello,
        lastError: hello.warning ?? null,
      });
      await this.refreshDeviceRuntime(deviceId);
      if (device.generation !== generation) throw new ConnectionError('ERR_BRIDGE_CLOSED', 'Connection was replaced.');
      if (device.state.runtime.connectionState !== 'connected') {
        throw new ConnectionError('HERDR_UNAVAILABLE', 'SSH is connected but Herdr is unavailable.');
      }
      this.setDeviceState(deviceId, {
        connection: 'connected',
        hello,
        lastError: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not start Herdr.';
      if (device.generation === generation) {
        device.sessionId = null;
        this.setDeviceState(deviceId, { connection: 'error', lastError: message });
      }
      throw error;
    }
  }

  async disconnectDevice(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) {
      return;
    }
    await this.releaseDevice(deviceId);
    device.unsubscribe();
    this.devices.delete(deviceId);
    if (this.selectedDeviceId === deviceId) this.selectedDeviceId = null;
    this.reindexAgents();
    this.publish();
    await this.persistRuntimes();
  }

  /** Detach transport without discarding the cached runtime or transcript. */
  async releaseDevice(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) return;
    device.generation++;
    device.sessionId = null;
    this.transcripts.detach(device.state.runtime.agents.map((agent) => agent.id));
    this.setDeviceState(deviceId, { connection: 'disconnected' });
    try {
      await this.dispatcher.detach(deviceId);
    } finally {
      await device.transport.stop();
    }
  }

  setConnectionState(deviceId: string, connection: HerdrConnectionState, lastError: string | null) {
    this.setDeviceState(deviceId, { connection, lastError });
  }

  async probeDevice(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device || !device.sessionId) throw new ConnectionError('ERR_BRIDGE_CLOSED', 'No bridge is attached.');
    // Refreshing the runtime probes Herdr as well as the SSH channel.
    await this.refreshDeviceRuntime(deviceId);
    if (device.state.runtime.connectionState !== 'connected') {
      throw new ConnectionError('HERDR_UNAVAILABLE', 'Herdr is unavailable.');
    }
  }

  async retry(): Promise<void> {
    const device = this.selectedDeviceId ? this.devices.get(this.selectedDeviceId) : undefined;
    if (!device || !this.reconnectHandler) {
      throw new Error('No device is available.');
    }
    await this.reconnectHandler(device.deviceId);
  }

  isDeviceConnected(deviceId: string): boolean {
    return this.devices.get(deviceId)?.state.connection === 'connected';
  }

  async createAgent(input: CreateAgentInput, targetDeviceId?: string): Promise<CreateAgentResult> {
    const request = createAgentInputSchema.parse(input);
    const deviceId = targetDeviceId ?? this.requireSelectedDeviceId();
    const result = createAgentResultSchema.parse(
      await this.deviceConnection(deviceId).transport.request('agent.create', request),
    );
    await this.installRuntime(deviceId, result.runtime);
    return result;
  }

  async renameAgent(agentId: string, name: string): Promise<AgentMutationResult> {
    const request = renameAgentInputSchema.parse({ agentId, name });
    return this.mutateAgent(agentId, 'agent.rename', request);
  }

  async retuneAgent(input: RetuneAgentInput): Promise<AgentMutationResult> {
    const request = retuneAgentInputSchema.parse(input);
    const deviceId = this.deviceIdForAgent(request.agentId);
    const device = deviceId ? this.devices.get(deviceId) : undefined;
    const agent = this.currentAgent(request.agentId);
    if (!device || !agent) throw new Error('That agent is not available on a connected device.');
    if (device.state.connection !== 'connected') {
      throw new ConnectionError('BRIDGE_NOT_STARTED', 'Reconnect this agent\u2019s device before changing model settings.');
    }
    const unavailable = retuningUnavailableReason(agent.provider, agent.capabilities);
    if (unavailable) throw new Error(unavailable);
    return this.mutateAgent(input.agentId, 'agent.retune', request);
  }

  async closeAgent(agentId: string): Promise<AgentMutationResult> {
    return this.mutateAgent(agentId, 'agent.close', { agentId });
  }

  /** Both replies carry a fresh runtime, since both change what is in the list. */
  private async mutateAgent(
    agentId: string,
    action: string,
    request: Record<string, unknown>,
  ): Promise<AgentMutationResult> {
    const deviceId = this.deviceIdForAgent(agentId);
    if (!deviceId) {
      throw new Error('That agent is not available on a connected device.');
    }
    const raw = await this.requestForAgent(agentId, action, request);
    const result = agentMutationResultSchema.parse(raw);
    await this.installRuntime(deviceId, result.runtime);
    return result;
  }

  async createSpace(input: CreateSpaceInput, targetDeviceId?: string): Promise<CreateSpaceResult> {
    const request = createSpaceInputSchema.parse(input);
    const deviceId = targetDeviceId ?? this.requireSelectedDeviceId();
    const result = createSpaceResultSchema.parse(
      await this.deviceConnection(deviceId).transport.request('workspace.create', request),
    );
    await this.installRuntime(deviceId, result.runtime);
    return result;
  }

  async closeSpace(workspaceId: string, closeGroup = false): Promise<CloseSpaceResult> {
    const request = closeSpaceInputSchema.parse({ workspaceId, closeGroup });
    const deviceId = this.requireSelectedDeviceId();
    const result = closeSpaceResultSchema.parse(
      await this.deviceConnection(deviceId).transport.request('workspace.close', request),
    );
    await this.installRuntime(deviceId, result.runtime);
    return result;
  }

  async refreshRuntime(deviceId?: string, includeActivity = false): Promise<void> {
    await this.refreshDeviceRuntime(deviceId ?? this.requireSelectedDeviceId(), includeActivity);
  }

  private async refreshDeviceRuntime(deviceId: string, includeActivity = false): Promise<void> {
    const device = this.deviceConnection(deviceId);
    const generation = device.generation;
    const runtime = runtimeStateSchema.parse(
      await device.transport.request('runtime.snapshot', includeActivity ? { includeActivity: true } : {}),
    );
    if (generation !== device.generation) throw new ConnectionError('ERR_BRIDGE_CLOSED', 'Stale runtime response.');
    await this.installRuntime(deviceId, runtime);
  }

  private async requestForAgent<T>(
    agentId: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<T> {
    const deviceId = this.deviceIdForAgent(agentId);
    const device = deviceId ? this.devices.get(deviceId) : undefined;
    const generation = device?.generation;
    try {
      return await this.transportForAgent(agentId).request<T>(action, payload);
    } catch (error) {
      if (deviceId && device?.generation === generation && classifyConnectionError(error).retryable) {
        this.connectionObserver?.(deviceId, error);
      }
      // Mutations without a command ID cannot be replayed after an ambiguous failure.
      throw error;
    }
  }

  async loadConversation(agentId: string): Promise<AgentConversation> {
    const conversation = await this.transcripts.load(agentId);
    return this.getConversation(agentId) ?? conversation;
  }

  restoreConversation(agentId: string): Promise<void> {
    return this.transcripts.restore(agentId);
  }

  private openConversationRequest(agentId: string): ConversationRequest {
    const deviceId = this.deviceIdForAgent(agentId);
    const device = deviceId ? this.devices.get(deviceId) : undefined;
    if (!device || !deviceId) throw new Error('That agent is not available on a connected device.');
    if (device.state.connection !== 'connected') throw new ConnectionError('BRIDGE_NOT_STARTED', 'Reconnecting to the device.');
    const generation = device.generation;
    return {
      read: () => this.requestForAgent(agentId, 'agent.conversation', { agentId }),
      assertAttached: () => {
        if (device.generation !== generation) throw new ConnectionError('ERR_BRIDGE_CLOSED', 'Stale conversation response.');
      },
      refreshIdentity: () => this.refreshDeviceRuntime(deviceId),
    };
  }

  private currentAgent(agentId: string): RemoteAgent | undefined {
    const deviceId = this.deviceIdForAgent(agentId);
    return deviceId ? this.devices.get(deviceId)?.state.runtime.agents.find((agent) => agent.id === agentId) : undefined;
  }

  private openCommandAttachment(deviceId: string): CommandAttachment | null {
    const device = this.devices.get(deviceId);
    if (!device || device.state.connection !== 'connected') return null;
    const generation = device.generation;
    return {
      isCurrent: () => device.generation === generation,
      supportsDurableCommands: () => device.state.hello?.capabilities.durableCommands === true,
      send: (command) => device.transport.request(command.action, command.payload, command.id),
    };
  }

  async sendMessage(agentId: string, text: string): Promise<void> {
    if (!text.trim()) throw new Error('Message cannot be empty.');
    await this.queueCommand(agentId, 'agent.send_message', { agentId, text }, text);
  }

  private async queueCommand(
    agentId: string, action: Exclude<PendingCommand['action'], 'agent.interrupt'>,
    payload: Record<string, unknown>, text: string,
    expectedSession: AgentSession | undefined = agentSession(this.currentAgent(agentId)),
  ): Promise<void> {
    await this.hydrate();
    const deviceId = this.deviceIdForAgent(agentId);
    const device = deviceId ? this.devices.get(deviceId) : undefined;
    const agent = device?.state.runtime.agents.find((candidate) => candidate.id === agentId);
    if (!device || !agent) throw new Error('This agent is no longer available.');
    if (expectedSession && !sameAgentSession(expectedSession, agentSession(agent))) {
      throw new Error('The agent session changed before the message could be queued. Review the current conversation.');
    }
    if (device.state.hello && device.state.hello.capabilities.durableCommands !== true) {
      throw new Error('Reconnect to update the device bridge before sending.');
    }
    if (!agent.providerSessionId) {
      if (agent.provider === 'codex') {
        throw new Error('Codex has not exposed its active thread yet. Finish its startup dialogs or enable Thread ID in Codex /statusline. New Remodr Codex agents enable this automatically.');
      }
      throw new Error('Waiting for the agent session identity. Reconnect or refresh before sending.');
    }
    await this.dispatcher.enqueue({
      agentId, deviceId: device.deviceId, action, text,
      payload: { ...payload, precondition: {
        provider: agent.provider, paneId: agent.paneId, providerSessionId: agent.providerSessionId,
      } },
      baselineIds: (this.transcripts.get(agentId)?.items ?? []).map((item) => item.id),
    });
  }

  async answerHumanRequest(
    agentId: string,
    requestId: string,
    answer: { selectedOptionIds?: string[]; customText?: string | null },
  ): Promise<void> {
    const conversation = this.transcripts.get(agentId);
    const agent = this.currentAgent(agentId);
    if (!conversation || !agent || !conversationMatchesAgent(conversation, agent)
      || conversation.activeHumanRequest?.id !== requestId) {
      throw new Error('This question no longer belongs to the current session. Refresh the conversation.');
    }
    const labels = conversation?.activeHumanRequest?.options
      .filter((option) => answer.selectedOptionIds?.includes(option.id))
      .map((option) => option.label).join(', ');
    await this.queueCommand(agentId, 'human_request.answer', {
      agentId,
      requestId,
      answer,
    }, answer.customText ?? labels ?? 'Answer', agentSession(agent));
  }

  async interrupt(agentId: string): Promise<void> {
    const deviceId = this.deviceIdForAgent(agentId);
    if (!deviceId || !this.isDeviceConnected(deviceId)) {
      throw new Error('Reconnect before interrupting. An interrupt will not be sent to a later run.');
    }
    // Herdr has no run token. Interrupt a live attachment once; do not queue it
    // where it could later cancel a different run in the same provider session.
    await this.requestForAgent(agentId, 'agent.interrupt', { agentId });
  }

  flushCommands(deviceId: string): Promise<void> {
    return this.dispatcher.flush(deviceId);
  }

  async retryCommand(id: string): Promise<void> {
    return this.dispatcher.retry(id);
  }

  async discardCommand(id: string): Promise<void> {
    return this.dispatcher.discard(id);
  }

  async cancelDeviceCommands(deviceId: string): Promise<void> {
    return this.dispatcher.cancelDevice(deviceId);
  }

  private publishConversations() {
    const merged = new Map(this.transcripts.getSnapshot());
    for (const command of this.dispatcher.getSnapshot()) {
      const device = this.devices.get(command.deviceId);
      const agent = device?.state.runtime.agents.find((entry) => entry.id === command.agentId);
      const previousSession = !!agent && !sameAgentSession(commandSession(command.payload), agentSession(agent));
      const conversation = merged.get(command.agentId) ?? {
        agentId: command.agentId, provider: agent?.provider ?? 'unknown', semantic: true, items: [],
      };
      merged.set(command.agentId, {
        ...conversation,
        items: [...conversation.items, {
          id: `local:${command.id}`, kind: 'user_message', text: command.text,
          timestamp: command.createdAt, commandId: command.id, delivery: command.state,
          previousSession,
          deliveryError: previousSession
            ? `Previous session. ${command.error ?? 'This message does not belong to the current conversation.'}`
            : command.error ?? undefined,
        }],
      });
    }
    this.conversations = merged;
    this.conversationListeners.forEach((listener) => listener());
  }

  async loadDraft(agentId: string): Promise<string> {
    return this.drafts.loadDraft(agentId);
  }

  async saveDraft(agentId: string, text: string): Promise<void> {
    return this.drafts.saveDraft(agentId, text);
  }

  diagnostics() {
    return {
      connection: this.state.connection,
      bridgeVersion: this.state.hello?.bridgeVersion,
      protocol: this.state.hello?.protocol,
      herdrVersion: this.state.runtime.herdrVersion,
      herdrSession: this.state.runtime.herdrSession,
      herdrSocket: this.state.runtime.socketPath,
      connectedDevices: [...this.devices.values()].filter(
        (device) => device.state.connection === 'connected',
      ).length,
      agents: totalDeviceAgentCount(this.state.agentCountsByDevice),
      lastRuntimeEvent: this.state.runtime.lastRuntimeEvent,
      lastSemanticEvent: this.state.lastSemanticEvent,
      lastError: this.state.lastError,
    };
  }

  private requireSelectedDeviceId(): string {
    if (!this.selectedDeviceId) {
      throw new Error('No device is selected.');
    }
    return this.selectedDeviceId;
  }

  private transportForAgent(agentId: string): HerdrBridgeTransport {
    const deviceId = this.agentIndex.get(agentId);
    const device = deviceId ? this.devices.get(deviceId) : undefined;
    if (!device) {
      throw new Error('That agent is not available on a connected device.');
    }
    return device.transport;
  }

  private async handleEvent(deviceId: string, event: BridgeEvent): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) return;
    if (event.event === 'runtime.snapshot') {
      const parsed = runtimeStateSchema.safeParse(event.data);
      if (parsed.success) {
        await this.installRuntime(deviceId, parsed.data);
      }
      return;
    }
    if (event.event === 'conversation.changed') {
      const data = event.data as { agentId?: unknown };
      if (typeof data.agentId === 'string' && this.conversations.has(data.agentId)) {
        await this.loadConversation(data.agentId);
      }
      this.lastSemanticEvent = event.event;
      this.publish();
      return;
    }
    if (event.event === 'connection.warning' || event.event === 'connection.closed') {
      const data = event.data as { message?: unknown; code?: unknown };
      const message = typeof data.message === 'string' ? data.message : 'Connection interrupted.';
      this.setDeviceState(deviceId, {
        connection: 'reconnecting',
        lastError: message,
      });
      this.connectionObserver?.(deviceId, new ConnectionError(
        event.event === 'connection.closed' ? 'ERR_BRIDGE_CLOSED' : 'HERDR_UNAVAILABLE', message,
      ));
    }
  }

  private async installRuntime(
    fallbackDeviceId: string,
    runtime: HerdrRuntimeState,
  ): Promise<void> {
    if (runtime.deviceId && runtime.deviceId !== fallbackDeviceId) {
      throw new ConnectionError('INVALID_RESPONSE', 'Runtime belongs to a different device.');
    }
    const deviceId = fallbackDeviceId;
    const device = this.deviceConnection(deviceId);
    const previousRuntime = device.state.runtime;
    if (device.runtimeGeneration === device.generation
      && runtime.runtimeRevision != null && device.state.runtime.runtimeRevision != null
      && runtime.runtimeRevision < device.state.runtime.runtimeRevision) {
      console.warn('[HERDR_RUNTIME] Ignored a stale runtime snapshot', deviceId);
      return;
    }
    const previousAgents = new Map(device.state.runtime.agents.map((agent) => [agent.id, agent]));
    const agents = runtime.agents.map((agent) => {
      const previous = previousAgents.get(agent.id);
      const tracked = {
        ...agent,
        observedStatus: agent.status,
        completion: completionForSnapshot(previous, agent, createId),
      };
      const lastOutputAt = previous?.lastOutputAt;
      if (agent.providerSessionId && lastOutputAt != null
        && sameAgentSession(agentSession(previous), agentSession(agent))
        && lastOutputAt > (agent.lastOutputAt ?? -1)) {
        return { ...tracked, lastOutputAt };
      }
      return tracked;
    });
    if (agents.some((agent, index) => agent !== runtime.agents[index])) runtime = { ...runtime, agents };
    device.state = { ...device.state, runtime };
    device.runtimeGeneration = device.generation;
    this.reindexAgents();
    const removals = this.transcripts.reconcileAgents(previousRuntime.agents, runtime.agents);
    this.publish();
    await removals;
    if (JSON.stringify(durableRuntime(previousRuntime)) !== JSON.stringify(durableRuntime(runtime))) {
      await this.persistRuntimes();
    }
  }

  private reindexAgents() {
    this.agentIndex = new Map();
    for (const device of this.devices.values()) {
      for (const agent of device.state.runtime.agents) {
        this.agentIndex.set(agent.id, device.deviceId);
      }
    }
  }

  private persistRuntimes(): Promise<void> {
    const operation = this.writingRuntimes.then(async () => {
      const cache: Record<string, HerdrRuntimeState> = {};
      for (const [deviceId, device] of this.devices) {
        if (device.state.runtime !== EMPTY_RUNTIME) cache[deviceId] = device.state.runtime;
      }
      await AsyncStorage.setItem(RUNTIME_CACHE_KEY, JSON.stringify(cache));
    });
    // Serialize metadata writes while returning storage errors to their callers.
    this.writingRuntimes = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private updateAgentStatus(agentId: string, status: AgentStatus) {
    const deviceId = this.agentIndex.get(agentId);
    const device = deviceId ? this.devices.get(deviceId) : undefined;
    if (!device) {
      return;
    }
    const runtime = reduceAgentStatus(device.state.runtime, agentId, status);
    if (runtime !== device.state.runtime) {
      this.setDeviceState(device.deviceId, { runtime });
    }
  }

  private setDeviceState(deviceId: string, patch: Partial<DeviceRuntimeState>) {
    const device = this.deviceConnection(deviceId);
    device.state = { ...device.state, ...patch };
    this.publish();
  }

  private publish() {
    const selected = this.selectedDeviceId
      ? this.devices.get(this.selectedDeviceId)
      : undefined;
    const devices: Record<string, DeviceRuntimeState> = {};
    const agentCountsByDevice: DeviceAgentCounts = {};
    for (const [deviceId, device] of this.devices) {
      devices[deviceId] = device.state;
      agentCountsByDevice[deviceId] = device.state.runtime.agents.length;
    }
    this.state = {
      connection: selected?.state.connection ?? 'disconnected',
      selectedDeviceId: this.selectedDeviceId,
      runtime: selected?.state.runtime ?? EMPTY_RUNTIME,
      devices,
      agentCountsByDevice,
      hello: selected?.state.hello ?? null,
      lastError: selected?.state.lastError ?? null,
      lastSemanticEvent: this.lastSemanticEvent,
    };
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

export const herdrRepository = new HerdrRepository();
