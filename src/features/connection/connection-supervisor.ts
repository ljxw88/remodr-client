export type ConnectionSnapshot = {
  phase:
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'degraded'
    | 'reconnecting'
    | 'fatal'
    | 'waiting_network'
    | 'suspended';
  disconnectedAt: number | null;
  attempt: number;
  nextRetryAt: number | null;
  lastError: string | null;
  errorCode: string | null;
};

export type ConnectionSupervisorDependencies = {
  connect(deviceId: string): Promise<void>;
  disconnect(deviceId: string): Promise<void>;
  probe(deviceId: string): Promise<void>;
  onChange?(deviceId: string, state: ConnectionSnapshot): void;
  classify(error: unknown): { retryable: boolean; message: string; code: string };
  random?: () => number;
  now?: () => number;
};

type Environment = {
  online: boolean;
  foreground: boolean;
  backgroundAllowed?: boolean;
};

type Timer = ReturnType<typeof setTimeout>;
type Device = {
  id: string;
  desired: boolean;
  generation: number;
  connected: boolean;
  resources: boolean;
  fatal: boolean;
  failed: boolean;
  state: ConnectionSnapshot;
  flight: { generation: number; promise: Promise<boolean> } | null;
  shutdown: Promise<void> | null;
  probe: { promise: Promise<void>; cancel(): void } | null;
  retryTimer: Timer | null;
  stableTimer: Timer | null;
  heartbeatTimer: Timer | null;
};

const STABLE_MS = 10_000;
const HEARTBEAT_MS = 15_000;
const PROBE_TIMEOUT_MS = 10_000;

export class ConnectionSupervisor {
  private readonly devices = new Map<string, Device>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly random: () => number;
  private environment: Environment = { online: true, foreground: true };
  private snapshot: Record<string, ConnectionSnapshot> = Object.freeze({});

  constructor(private readonly dependencies: ConnectionSupervisorDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
  }

  getSnapshot = (): Record<string, ConnectionSnapshot> => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  ensure(deviceId: string, options?: { retryFatal?: boolean }): Promise<boolean> {
    let device = this.devices.get(deviceId);
    if (!device) {
      device = {
        id: deviceId,
        desired: false,
        generation: 0,
        connected: false,
        resources: false,
        fatal: false,
        failed: false,
        state: this.initialState(),
        flight: null,
        shutdown: null,
        probe: null,
        retryTimer: null,
        stableTimer: null,
        heartbeatTimer: null,
      };
      this.devices.set(deviceId, device);
    }
    if (!device.desired) {
      device.desired = true;
      device.generation += 1;
      device.fatal = false;
      device.failed = false;
      this.publish(device, this.initialState());
    }
    if (options?.retryFatal) return this.retryNow(deviceId);
    if (device.fatal) return Promise.resolve(false);
    if (!this.active()) {
      this.publish(device, { phase: this.pausedPhase(), nextRetryAt: null });
      return Promise.resolve(false);
    }
    // Repeated store reconciliation must not replace or accelerate an existing retry.
    if (device.retryTimer !== null) return Promise.resolve(false);
    if (device.failed) return device.flight?.promise ?? Promise.resolve(false);
    return this.attempt(device);
  }

  retryNow(deviceId: string): Promise<boolean> {
    const device = this.devices.get(deviceId);
    if (!device?.desired) return this.ensure(deviceId);
    device.fatal = false;
    this.clearTimer(device, 'retryTimer');
    this.publish(device, {
      nextRetryAt: null,
      ...(device.state.phase === 'fatal' ? { phase: 'disconnected' as const } : {}),
    });
    if (!this.active()) {
      this.publish(device, { phase: this.pausedPhase() });
      return Promise.resolve(false);
    }
    return this.attempt(device);
  }

  invalidate(deviceId: string, error: unknown): void {
    const device = this.devices.get(deviceId);
    if (!device?.desired) return;
    this.fail(device, error);
    if (!device.flight && !device.shutdown) {
      if (device.resources) this.startCleanup(device);
      else this.scheduleRetry(device);
    }
  }

  remove(deviceId: string): Promise<void> {
    const device = this.devices.get(deviceId);
    if (!device) return Promise.resolve();
    if (device.desired) {
      device.desired = false;
      device.generation += 1;
      device.connected = false;
      this.cancelTimers(device);
      this.unpublish(deviceId);
    }
    if (device.shutdown) return device.shutdown;

    // A non-abortable connect retains ownership until it settles and is cleaned up.
    // Keep the tombstone in the map so a concurrent explicit ensure waits for it.
    const shutdown = Promise.resolve(device.flight?.promise)
      .then(async () => {
        await this.cleanup(device);
      })
      .catch((error: unknown) => {
        if (device.desired) this.fail(device, error);
      })
      .finally(() => {
        device.shutdown = null;
        if (!device.desired && !device.resources) this.devices.delete(device.id);
      });
    device.shutdown = shutdown;
    return shutdown;
  }

  setEnvironment(environment: Environment): void {
    const wasActive = this.active();
    const previous = this.environment;
    this.environment = { ...environment };
    if (
      previous.online === environment.online &&
      previous.foreground === environment.foreground &&
      !!previous.backgroundAllowed === !!environment.backgroundAllowed
    ) return;
    const active = this.active();
    for (const device of this.devices.values()) {
      if (!device.desired || device.fatal) continue;
      if (!active) {
        if (wasActive) device.generation += 1;
        const interruptedProbe = device.probe !== null;
        this.cancelTimers(device);
        // A fenced probe may still be executing. Release its transport rather
        // than starting another probe on that same transport after resuming.
        if (interruptedProbe) device.connected = false;
        this.publish(device, {
          phase: this.pausedPhase(),
          nextRetryAt: null,
          disconnectedAt: device.state.disconnectedAt ?? this.now(),
        });
        if (interruptedProbe && !device.flight && !device.shutdown) this.startCleanup(device);
      } else if (!wasActive || (!previous.foreground && environment.foreground)) {
        if (device.connected) {
          this.publish(device, { phase: 'degraded' });
          void this.probe(device);
        } else {
          void this.attempt(device);
        }
      }
    }
  }

  networkChanged(): void {
    if (!this.active()) return;
    for (const device of this.devices.values()) {
      if (!device.desired || device.fatal) continue;
      if (device.connected) void this.probe(device);
      else {
        this.clearTimer(device, 'retryTimer');
        void this.attempt(device);
      }
    }
  }

  async checkHealth(): Promise<void> {
    if (!this.active()) return;
    await Promise.all(
      [...this.devices.values()]
        .filter((device) => device.desired && device.connected && !device.fatal)
        .map((device) => this.probe(device)),
    );
  }

  // Stop the current lifecycle, but allow an explicit ensure after a Strict Mode
  // remount. Per-device shutdown tombstones serialize that restart with cleanup.
  dispose(): void {
    this.listeners.clear();
    for (const device of this.devices.values()) void this.remove(device.id);
  }

  private initialState(): ConnectionSnapshot {
    return {
      phase: 'disconnected',
      disconnectedAt: this.now(),
      attempt: 0,
      nextRetryAt: null,
      lastError: null,
      errorCode: null,
    };
  }

  private active(): boolean {
    return this.environment.online &&
      (this.environment.foreground || !!this.environment.backgroundAllowed);
  }

  private pausedPhase(): 'waiting_network' | 'suspended' {
    return this.environment.online ? 'suspended' : 'waiting_network';
  }

  private current(device: Device, generation: number): boolean {
    return device.desired && device.generation === generation;
  }

  private attempt(device: Device): Promise<boolean> {
    if (!device.desired || device.fatal || !this.active()) {
      return Promise.resolve(false);
    }
    const generation = device.generation;
    if (device.shutdown || device.flight) {
      if (!device.shutdown && device.flight?.generation === generation) {
        return device.flight.promise;
      }
      const pending = device.shutdown ?? device.flight!.promise;
      return pending.then(() =>
        this.current(device, generation) ? this.attempt(device) : false,
      );
    }
    if (device.connected) return Promise.resolve(true);
    this.clearTimer(device, 'retryTimer');
    const promise = Promise.resolve()
      .then(() => this.runAttempt(device, generation))
      .finally(() => {
        device.flight = null;
        if (device.connected && device.state.phase === 'degraded') void this.probe(device);
        else this.scheduleRetry(device);
      });
    device.flight = { generation, promise };
    this.publish(device, {
      phase: device.state.attempt ? 'reconnecting' : 'connecting',
      nextRetryAt: null,
    });
    return promise;
  }

  private async runAttempt(device: Device, generation: number): Promise<boolean> {
    try {
      if (!this.current(device, generation)) return false;
      device.failed = false;
      await this.cleanup(device);
      if (!this.current(device, generation) || !this.active() || device.fatal) return false;
      device.resources = true;
      await this.dependencies.connect(device.id);
      if (!this.current(device, generation) || !this.active()) return false;
      device.connected = true;
      this.publish(device, {
        phase: 'connected',
        disconnectedAt: null,
        nextRetryAt: null,
        lastError: null,
        errorCode: null,
      });
      if (this.current(device, generation) && device.connected) {
        this.startStableTimer(device);
        this.startHeartbeat(device);
        return true;
      }
      return false;
    } catch (error) {
      if (this.current(device, generation)) this.fail(device, error);
      return false;
    } finally {
      if (!device.connected) {
        try {
          await this.cleanup(device);
        } catch (error) {
          if (device.desired) this.fail(device, error);
        }
      }
    }
  }

  private startCleanup(device: Device): void {
    const generation = device.generation;
    const promise = Promise.resolve()
      .then(() => this.cleanup(device))
      .catch((error: unknown) => {
        if (device.desired) this.fail(device, error);
      })
      .then(() => false)
      .finally(() => {
        device.flight = null;
        this.scheduleRetry(device);
      });
    // Cleanup isn't a connection attempt; an ensure must wait and then try connecting.
    device.flight = { generation: generation - 1, promise };
  }

  private async cleanup(device: Device): Promise<void> {
    if (!device.resources) return;
    await this.dependencies.disconnect(device.id);
    device.resources = false;
  }

  private fail(device: Device, error: unknown): void {
    let failure: ReturnType<ConnectionSupervisorDependencies['classify']>;
    try {
      failure = this.dependencies.classify(error);
    } catch (error) {
      console.warn('[CONNECTION] Error classification failed', error);
      failure = { retryable: false, code: 'UNKNOWN', message: 'Connection failed.' };
    }
    if (device.fatal) return;
    if (device.failed && failure.retryable) {
      this.publish(device, { lastError: failure.message, errorCode: failure.code });
      return;
    }
    const wasConnected = device.connected;
    const attempt = device.state.attempt + (device.failed ? 0 : 1);
    device.failed = true;
    device.connected = false;
    device.fatal = !failure.retryable;
    device.generation += 1;
    this.cancelTimers(device);
    this.publish(device, {
      phase: device.fatal
        ? 'fatal'
        : !this.active() ? this.pausedPhase() : wasConnected ? 'degraded' : 'reconnecting',
      attempt,
      disconnectedAt: device.state.disconnectedAt ?? this.now(),
      nextRetryAt: null,
      lastError: failure.message,
      errorCode: failure.code,
    });
  }

  private scheduleRetry(device: Device): void {
    if (
      !device.desired || device.connected || device.fatal ||
      !this.active() || device.flight || device.shutdown || device.retryTimer !== null
    ) return;
    const ceiling = Math.min(30_000, 500 * 2 ** Math.min(16, Math.max(0, device.state.attempt - 2)));
    const delay = device.state.attempt <= 1 ? 0 : Math.floor(this.random() * ceiling);
    const generation = device.generation;
    device.retryTimer = setTimeout(() => {
      device.retryTimer = null;
      if (this.current(device, generation)) void this.attempt(device);
    }, delay);
    this.publish(device, { phase: 'reconnecting', nextRetryAt: this.now() + delay });
  }

  private startStableTimer(device: Device): void {
    if (
      device.stableTimer !== null || !this.active() || device.probe ||
      device.state.attempt === 0 || !device.desired || !device.connected ||
      device.fatal
    ) return;
    const generation = device.generation;
    device.stableTimer = setTimeout(() => {
      device.stableTimer = null;
      if (this.current(device, generation) && device.connected && !device.probe) {
        this.publish(device, { attempt: 0 });
      }
    }, STABLE_MS);
  }

  private startHeartbeat(device: Device): void {
    if (
      device.heartbeatTimer !== null || !this.active() || !device.connected ||
      !device.desired || device.fatal
    ) return;
    const generation = device.generation;
    device.heartbeatTimer = setTimeout(() => {
      device.heartbeatTimer = null;
      if (this.current(device, generation)) void this.probe(device);
    }, HEARTBEAT_MS);
  }

  private probe(device: Device): Promise<void> {
    if (device.probe) return device.probe.promise;
    if (
      !device.desired || !device.connected || device.fatal || device.flight ||
      device.shutdown || !this.active()
    ) return Promise.resolve();
    const generation = device.generation;
    this.clearTimer(device, 'heartbeatTimer');
    let settle!: () => void;
    let done = false;
    const promise = new Promise<void>((resolve) => { settle = resolve; });
    const cancel = () => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      device.probe = null;
      settle();
    };
    const finish = (failed: boolean, error?: unknown) => {
      if (done) return;
      cancel();
      if (!this.current(device, generation) || !device.connected || !this.active()) return;
      if (failed) {
        this.invalidate(device.id, error);
      } else {
        this.publish(device, { phase: 'connected', disconnectedAt: null });
        this.startStableTimer(device);
        this.startHeartbeat(device);
      }
    };
    const deadline = setTimeout(() => {
      finish(true, Object.assign(new Error('Connection health probe timed out.'), {
        code: 'ERR_BRIDGE_TIMEOUT',
      }));
    }, PROBE_TIMEOUT_MS);
    device.probe = { promise, cancel };
    // The deadline fences only the result. Disconnect releases the old transport
    // before reconnect; it does not claim to cancel the underlying probe promise.
    void Promise.resolve()
      .then(() => {
        if (!done) return this.dependencies.probe(device.id);
      })
      .then(() => finish(false), (error: unknown) => finish(true, error));
    return promise;
  }

  private clearTimer(
    device: Device,
    key: 'retryTimer' | 'stableTimer' | 'heartbeatTimer',
  ): void {
    const timer = device[key];
    if (timer !== null) clearTimeout(timer);
    device[key] = null;
  }

  private cancelTimers(device: Device): void {
    this.clearTimer(device, 'retryTimer');
    this.clearTimer(device, 'stableTimer');
    this.clearTimer(device, 'heartbeatTimer');
    device.probe?.cancel();
  }

  private publish(device: Device, patch: Partial<ConnectionSnapshot>): void {
    if (!device.desired) return;
    const state = { ...device.state, ...patch };
    if (
      this.snapshot[device.id] === device.state &&
      (Object.keys(state) as (keyof ConnectionSnapshot)[])
        .every((key) => state[key] === device.state[key])
    ) return;
    device.state = Object.freeze(state);
    this.snapshot = Object.freeze({ ...this.snapshot, [device.id]: device.state });
    try {
      this.dependencies.onChange?.(device.id, device.state);
    } catch (error) {
      // Observers must not change the outcome of a transport operation.
      console.warn('[CONNECTION] State observer failed', error);
    }
    this.notify();
  }

  private unpublish(deviceId: string): void {
    if (!Object.hasOwn(this.snapshot, deviceId)) return;
    const snapshot = { ...this.snapshot };
    delete snapshot[deviceId];
    this.snapshot = Object.freeze(snapshot);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        // Other subscribers still need the new snapshot.
        console.warn('[CONNECTION] Subscriber failed', error);
      }
    }
  }
}
