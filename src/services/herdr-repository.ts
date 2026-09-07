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
import { classifyConnectionError, connectionErrorCode, ConnectionError } from '@/domain/connection-error';
import { CommandOutbox, type PendingCommand } from '@/services/command-outbox';
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
  private draining = new Map<string, Promise<void>>();
  private outboxTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private writingRuntimes: Promise<void> = Promise.resolve();
  private readonly drafts = new DraftStore(AsyncStorage);

  constructor(
    private readonly createTransport: () => HerdrBridgeTransport = () =>
      new HerdrBridgeTransport(),
    private readonly outbox = new CommandOutbox(),
  ) {
    this.transcripts = new ConversationStore({
      getAgent: (agentId) => this.currentAgent(agentId),
      open: (agentId) => this.openConversationRequest(agentId),
    }, AsyncStorage, (conversation) => this.reconcileCommands(conversation));
    this.transcripts.subscribe(() => this.publishConversations());
    outbox.subscribe(() => this.publishConversations());
  }

  setReconnectHandler(handler: (deviceId: string) => Promise<boolean>) {
    this.reconnectHandler = handler;
  }

  setConnectionObserver(handler: (deviceId: string, error: unknown) => void) {
    this.connectionObserver = handler;
  }

  getPendingCommands = () => this.outbox.getSnapshot();
  subscribeCommands = (listener: () => void) => this.outbox.subscribe(listener);

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
    const attempt = Promise.all([this.hydrateFromStorage(), this.outbox.hydrate()]).then(() => {
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
    clearTimeout(this.outboxTimers.get(deviceId));
    this.outboxTimers.delete(deviceId);
    this.setDeviceState(deviceId, { connection: 'disconnected' });
    try {
      await this.outbox.hydrate();
      for (const command of this.outbox.getSnapshot()) {
        if (command.deviceId === deviceId && command.action === 'agent.interrupt' &&
          ['queued', 'sending'].includes(command.state)) {
          await this.outbox.update(command.id, {
            state: command.attempted ? 'uncertain' : 'failed', invalidated: true,
            error: 'The connection changed. This interrupt will not be sent to a later run.',
          });
        }
      }
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
    await this.outbox.enqueue({
      agentId, deviceId: device.deviceId, action, text,
      payload: { ...payload, precondition: {
        provider: agent.provider, paneId: agent.paneId, providerSessionId: agent.providerSessionId,
      } },
      baselineIds: (this.transcripts.get(agentId)?.items ?? []).map((item) => item.id),
    });
    if (this.isDeviceConnected(device.deviceId)) this.scheduleDrain(device.deviceId);
    else if (this.reconnectHandler) {
      // Queueing is not evidence of a failed connection. Join an existing
      // attempt rather than invalidating the attachment that is being opened.
      void this.reconnectHandler(device.deviceId).catch((error) => {
        console.warn('[CONNECTION] Queued message is waiting for recovery', error);
      });
    }
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
    clearTimeout(this.outboxTimers.get(deviceId));
    this.outboxTimers.delete(deviceId);
    const active = this.draining.get(deviceId);
    if (active) return active;
    const attempt = (async () => {
      await this.outbox.hydrate();
      // A previous flush may have received its ACK but failed to persist it.
      // Reuse the durable ID; never mint another ID for that outcome.
      for (const command of this.outbox.getSnapshot()) {
        if (command.deviceId === deviceId && command.state === 'sending') {
          await this.outbox.update(command.id, {
            state: command.action === 'agent.interrupt' ? 'uncertain' : 'queued',
          });
        }
      }
      await this.drainCommands(deviceId);
    })().finally(() => {
      if (this.draining.get(deviceId) === attempt) this.draining.delete(deviceId);
      if (this.isDeviceConnected(deviceId) && this.outbox.getSnapshot().some((command) =>
        command.deviceId === deviceId && (command.state === 'queued' || command.state === 'sending'),
      )) this.scheduleDrain(deviceId, 5000);
    });
    this.draining.set(deviceId, attempt);
    return attempt;
  }

  private scheduleDrain(deviceId: string, delay = 0) {
    if (this.outboxTimers.has(deviceId)) return;
    this.outboxTimers.set(deviceId, setTimeout(() => {
      this.outboxTimers.delete(deviceId);
      void this.flushCommands(deviceId).catch((error) => {
        console.warn('[OUTBOX] Could not process persisted commands', error);
        this.setDeviceState(deviceId, { lastError: 'Could not update the saved send queue.' });
      });
    }, delay));
  }

  private async drainCommands(deviceId: string): Promise<void> {
    await this.outbox.hydrate();
    const device = this.devices.get(deviceId);
    if (!device || device.state.connection !== 'connected') return;
    const generation = device.generation;
    while (device.generation === generation && device.state.connection === 'connected') {
      const commands = this.outbox.getSnapshot().filter((entry) => entry.deviceId === deviceId);
      const uncertain = commands.filter((entry) => entry.state === 'uncertain');
      const command = commands.find((entry) => entry.state === 'queued' && !entry.invalidated
        && !uncertain.some((blocked) => blocked.agentId === entry.agentId
          && sameAgentSession(commandSession(blocked.payload), commandSession(entry.payload))));
      if (!command) return;
      if (device.state.hello?.capabilities.durableCommands !== true) {
        await this.outbox.update(command.id, { state: 'failed', error: 'Reconnect to update the device bridge.' });
        continue;
      }
      if (Date.now() - command.createdAt > 24 * 60 * 60 * 1000) {
        await this.outbox.update(command.id, {
          state: command.attempted ? 'uncertain' : 'failed', error: 'This queued command has expired. Review the conversation.',
        });
        continue;
      }
      if (command.action === 'agent.interrupt' && command.attempted) {
        await this.outbox.update(command.id, { state: 'uncertain', error: 'Interrupt delivery could not be confirmed.' });
        continue;
      }
      try {
        if (!command.attempted) {
          // Capture an authoritative baseline before a first send. A cached
          // transcript may contain an older message with exactly the same text.
          await this.loadConversation(command.agentId);
          if (!sameAgentSession(commandSession(command.payload), agentSession(this.currentAgent(command.agentId)))) {
            await this.outbox.update(command.id, {
              state: 'failed', invalidated: true,
              error: 'The agent session changed. This message was not sent to the new session.',
            });
            continue;
          }
          await this.outbox.setBaseline(command.id,
            (this.transcripts.get(command.agentId)?.items ?? []).map((item) => item.id));
        }
        if (device.generation !== generation || device.state.connection !== 'connected') return;
        const claimed = await this.outbox.claim(command.id);
        if (!claimed) continue;
        if (device.generation !== generation || device.state.connection !== 'connected') {
          await this.outbox.update(command.id, {
            state: command.action === 'agent.interrupt' ? 'failed' : 'queued',
            invalidated: command.action === 'agent.interrupt',
          });
          return;
        }
        if (!command.attempted
          && !sameAgentSession(commandSession(claimed.payload), agentSession(this.currentAgent(command.agentId)))) {
          await this.outbox.update(command.id, {
            state: 'failed', invalidated: true,
            error: 'The agent session changed before dispatch. This message was not sent to the new session.',
          });
          continue;
        }
        await device.transport.request(claimed.action, claimed.payload, claimed.id);
        await this.outbox.update(command.id, { state: 'sent', error: null });
        if (command.action !== 'agent.interrupt') this.updateAgentStatus(command.agentId, 'working');
        if (command.action === 'agent.interrupt') await this.outbox.remove(command.id);
        // ACK is already durable; a refresh failure must never put the command back in the queue.
        void this.loadConversation(command.agentId).catch((error) => {
          console.warn('[CONVERSATION] Will refresh acknowledged command after reconnect', error);
        });
      } catch (error) {
        const code = connectionErrorCode(error);
        if (classifyConnectionError(error).retryable || code === 'COMMAND_IN_PROGRESS') {
          await this.outbox.update(command.id, {
            state: command.action === 'agent.interrupt' ? 'uncertain' : 'queued',
            error: command.action === 'agent.interrupt' ? 'Interrupt delivery could not be confirmed.' : null,
          });
          if (code === 'COMMAND_IN_PROGRESS') this.scheduleDrain(deviceId, 2000);
          else if (device.generation === generation) this.connectionObserver?.(deviceId, error);
          return;
        }
        await this.outbox.update(command.id, {
          state: code === 'COMMAND_UNCERTAIN' ? 'uncertain' : 'failed',
          error: error instanceof Error ? error.message : 'The command could not be delivered.',
        });
      }
    }
  }

  async retryCommand(id: string): Promise<void> {
    const command = this.outbox.getSnapshot().find((entry) => entry.id === id);
    if (!command) throw new Error('This command is no longer queued.');
    if (!sameAgentSession(commandSession(command.payload), agentSession(this.currentAgent(command.agentId)))) {
      throw new Error('This message belongs to a previous session. Compose a new message for the current session.');
    }
    if (command.invalidated) throw new Error('The device configuration changed. Review and compose a new message.');
    if (command.state === 'sending' || command.state === 'sent') return;
    if (command.state === 'uncertain') {
      throw new Error('Delivery is uncertain. Review the conversation before sending another message.');
    }
    await this.outbox.update(id, { state: 'queued', error: null });
    if (this.isDeviceConnected(command.deviceId)) this.scheduleDrain(command.deviceId);
    else await this.reconnectHandler?.(command.deviceId);
  }

  async discardCommand(id: string): Promise<void> {
    await this.outbox.discard(id);
  }

  async cancelDeviceCommands(deviceId: string): Promise<void> {
    await this.outbox.hydrate();
    for (const command of this.outbox.getSnapshot()) {
      if (command.deviceId !== deviceId || command.state === 'sent') continue;
      await this.outbox.update(command.id, {
        state: command.attempted ? 'uncertain' : 'failed', invalidated: true,
        error: 'Device settings changed. This command will not be sent to the new endpoint.',
      });
    }
  }

  private async reconcileCommands(conversation: AgentConversation) {
    const claimed = new Set<string>();
    for (const command of this.outbox.getSnapshot()) {
      if (command.agentId !== conversation.agentId || command.state !== 'sent') continue;
      const agent = this.currentAgent(conversation.agentId);
      if (!agent || !conversationMatchesAgent(conversation, agent)
        || !sameAgentSession(commandSession(command.payload), agentSession(agent))) continue;
      const match = conversation.items.find((item) => item.kind === 'user_message' &&
        item.text === command.text && !command.baselineIds.includes(item.id) && !claimed.has(item.id));
      if (match) {
        claimed.add(match.id);
        await this.outbox.reconcile(command.id, match.id);
      } else if (command.action === 'human_request.answer' &&
        conversation.activeHumanRequest?.id !== command.payload.requestId) {
        await this.outbox.remove(command.id);
      }
    }
  }

  private publishConversations() {
    const merged = new Map(this.transcripts.getSnapshot());
    for (const command of this.outbox.getSnapshot()) {
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
