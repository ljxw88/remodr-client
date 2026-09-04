import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  closeSpaceInputSchema,
  closeSpaceResultSchema,
  conversationSchema,
  agentMutationResultSchema,
  createAgentInputSchema,
  createAgentResultSchema,
  renameAgentInputSchema,
  createSpaceInputSchema,
  createSpaceResultSchema,
  EMPTY_RUNTIME,
  runtimeStateSchema,
  totalDeviceAgentCount,
  type AgentConversation,
  type AgentStatus,
  type BridgeEvent,
  type BridgeHello,
  type CloseSpaceResult,
  type AgentMutationResult,
  type CreateAgentInput,
  type CreateAgentResult,
  type CreateSpaceInput,
  type CreateSpaceResult,
  type DeviceAgentCounts,
  type HerdrConnectionState,
  type HerdrRuntimeState,
} from '@/domain/herdr';
import { HerdrBridgeTransport } from '@/services/herdr-bridge-transport';

const RUNTIME_CACHE_KEY = 'remote-workspace.herdr.runtimes.v2';
const DRAFT_PREFIX = 'remote-workspace.herdr.draft.';

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

  constructor(
    private readonly createTransport: () => HerdrBridgeTransport = () =>
      new HerdrBridgeTransport(),
  ) {}

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
    const attempt = this.hydrateFromStorage().finally(() => {
      this.hydrated = true;
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
    this.setDeviceState(deviceId, {
      connection: device.state.runtime.agents.length > 0 ? 'reconnecting' : 'starting_bridge',
    });
    try {
      const hello = await device.transport.start(sessionId);
      this.setDeviceState(deviceId, {
        connection: 'synchronizing',
        hello,
        lastError: hello.warning ?? null,
      });
      await this.refreshDeviceRuntime(deviceId);
      this.setDeviceState(deviceId, {
        connection: 'connected',
        hello,
        lastError: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not start Herdr.';
      if (device.sessionId === sessionId) {
        device.sessionId = null;
      }
      this.setDeviceState(deviceId, { connection: 'error', lastError: message });
      throw error;
    }
  }

  async disconnectDevice(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) {
      return;
    }
    device.unsubscribe();
    this.devices.delete(deviceId);
    this.reindexAgents();
    this.publish();
    await device.transport.stop();
  }

  async retry(): Promise<void> {
    const device = this.selectedDeviceId ? this.devices.get(this.selectedDeviceId) : undefined;
    if (!device?.sessionId) {
      throw new Error('No SSH session is available.');
    }
    await this.connect(device.sessionId, device.deviceId);
  }

  isDeviceConnected(deviceId: string): boolean {
    return this.devices.get(deviceId)?.state.connection === 'connected';
  }

  async createAgent(input: CreateAgentInput): Promise<CreateAgentResult> {
    const request = createAgentInputSchema.parse(input);
    const deviceId = this.requireSelectedDeviceId();
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
    const result = agentMutationResultSchema.parse(
      await this.transportForAgent(agentId).request(action, request),
    );
    await this.installRuntime(deviceId, result.runtime);
    return result;
  }

  async createSpace(input: CreateSpaceInput): Promise<CreateSpaceResult> {
    const request = createSpaceInputSchema.parse(input);
    const deviceId = this.requireSelectedDeviceId();
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

  async refreshRuntime(): Promise<void> {
    await this.refreshDeviceRuntime(this.requireSelectedDeviceId());
  }

  private async refreshDeviceRuntime(deviceId: string): Promise<void> {
    const runtime = runtimeStateSchema.parse(
      await this.deviceConnection(deviceId).transport.request('runtime.snapshot', {}),
    );
    await this.installRuntime(deviceId, runtime);
  }

  async loadConversation(agentId: string): Promise<AgentConversation> {
    const conversation = conversationSchema.parse(
      await this.transportForAgent(agentId).request('agent.conversation', { agentId }),
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
      await this.transportForAgent(agentId).request('agent.send_message', { agentId, text });
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
    await this.transportForAgent(agentId).request('human_request.answer', {
      agentId,
      requestId,
      answer,
    });
    this.updateAgentStatus(agentId, 'working');
  }

  async interrupt(agentId: string): Promise<void> {
    await this.transportForAgent(agentId).request('agent.interrupt', { agentId });
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
    if (event.event === 'runtime.snapshot') {
      const parsed = runtimeStateSchema.safeParse(event.data);
      if (parsed.success) {
        await this.installRuntime(deviceId, parsed.data);
        this.setDeviceState(deviceId, { connection: 'connected' });
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
    if (event.event === 'connection.warning') {
      const data = event.data as { message?: unknown };
      this.setDeviceState(deviceId, {
        connection: 'reconnecting',
        lastError: typeof data.message === 'string' ? data.message : 'Connection interrupted.',
      });
    }
  }

  private async installRuntime(
    fallbackDeviceId: string,
    runtime: HerdrRuntimeState,
  ): Promise<void> {
    const deviceId = runtime.deviceId ?? fallbackDeviceId;
    this.setDeviceState(deviceId, { runtime });
    this.reindexAgents();
    this.publish();
    await this.persistRuntimes();
  }

  private reindexAgents() {
    this.agentIndex = new Map();
    for (const device of this.devices.values()) {
      for (const agent of device.state.runtime.agents) {
        this.agentIndex.set(agent.id, device.deviceId);
      }
    }
  }

  private async persistRuntimes(): Promise<void> {
    const cache: Record<string, HerdrRuntimeState> = {};
    for (const [deviceId, device] of this.devices) {
      if (device.state.runtime !== EMPTY_RUNTIME) {
        cache[deviceId] = device.state.runtime;
      }
    }
    await AsyncStorage.setItem(RUNTIME_CACHE_KEY, JSON.stringify(cache));
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
