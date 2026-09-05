import {
  ConnectionSupervisor,
  type ConnectionSnapshot,
  type ConnectionSupervisorDependencies,
} from './connection-supervisor';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function error(code = 'ERR_NETWORK') {
  return Object.assign(new Error(code), { code });
}

async function flush() {
  for (let index = 0; index < 25; index += 1) await Promise.resolve();
}

function setup(overrides: Partial<ConnectionSupervisorDependencies> = {}) {
  const dependencies = {
    connect: jest.fn(async (_id: string) => {}),
    disconnect: jest.fn(async (_id: string) => {}),
    probe: jest.fn(async (_id: string) => {}),
    onChange: jest.fn(),
    classify: jest.fn((failure: unknown) => {
      const code = (failure as { code?: string } | null)?.code ?? 'UNKNOWN';
      return {
        retryable: code === 'ERR_NETWORK' || code === 'ERR_BRIDGE_TIMEOUT',
        code,
        message: failure instanceof Error ? failure.message : 'Connection failed.',
      };
    }),
    random: jest.fn(() => 0.5),
    ...overrides,
  };
  const supervisor = new ConnectionSupervisor(dependencies);
  return { supervisor, dependencies };
}

describe('ConnectionSupervisor', () => {
  const supervisors: ConnectionSupervisor[] = [];

  function create(overrides: Partial<ConnectionSupervisorDependencies> = {}) {
    const result = setup(overrides);
    supervisors.push(result.supervisor);
    return result;
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(100_000);
  });

  afterEach(async () => {
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    await flush();
    jest.useRealTimers();
  });

  it('deduplicates one device without blocking a different device', async () => {
    const pending = deferred();
    const connect = jest.fn((id: string) => id === 'a' ? pending.promise : Promise.resolve());
    const { supervisor } = create({ connect });
    const first = supervisor.ensure('a');
    const second = supervisor.ensure('a');
    expect(second).toBe(first);
    await expect(supervisor.ensure('b')).resolves.toBe(true);
    expect(supervisor.getSnapshot().a.phase).toBe('connecting');
    expect(supervisor.getSnapshot().b.phase).toBe('connected');
    pending.resolve();
    await expect(first).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('publishes the ready snapshot before notifying connected, only after connect fully resolves', async () => {
    const synchronized = deferred();
    let supervisor!: ConnectionSupervisor;
    const observedSnapshots: ConnectionSnapshot[] = [];
    const onChange = jest.fn((id: string, _state: ConnectionSnapshot) => {
      observedSnapshots.push(supervisor.getSnapshot()[id]);
    });
    ({ supervisor } = create({ connect: () => synchronized.promise, onChange }));
    const attempt = supervisor.ensure('a');
    await flush();
    expect(supervisor.getSnapshot().a.phase).toBe('connecting');
    expect(onChange.mock.calls.some(([, state]) => state.phase === 'connected')).toBe(false);
    synchronized.resolve();
    await expect(attempt).resolves.toBe(true);
    expect(onChange).toHaveBeenLastCalledWith('a', supervisor.getSnapshot().a);
    expect(supervisor.getSnapshot().a.phase).toBe('connected');
    for (const [index, [, state]] of onChange.mock.calls.entries()) {
      expect(observedSnapshots[index]).toBe(state);
    }
  });

  it('ignores repository invalidations for unknown, removed and disposed devices', async () => {
    const { supervisor, dependencies } = create();
    supervisor.invalidate('never-supervised', error());
    expect(supervisor.getSnapshot()).toEqual({});
    expect(dependencies.classify).not.toHaveBeenCalled();
    await supervisor.ensure('removed');
    await supervisor.remove('removed');
    supervisor.invalidate('removed', error());
    await supervisor.ensure('disposed');
    supervisor.dispose();
    supervisor.invalidate('disposed', error());
    supervisor.invalidate('cached-offline', error());
    supervisor.setEnvironment({ online: false, foreground: false });
    supervisor.setEnvironment({ online: true, foreground: true });
    supervisor.networkChanged();
    await supervisor.checkHealth();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(supervisor.getSnapshot()).toEqual({});
    expect(dependencies.connect).toHaveBeenCalledTimes(2);
    expect(dependencies.classify).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('returns an attempt result, retries once immediately, then uses capped full jitter', async () => {
    const connect = jest.fn(async () => { throw error(); });
    const { supervisor, dependencies } = create({ connect });
    await expect(supervisor.ensure('a')).resolves.toBe(false);
    expect(supervisor.getSnapshot().a).toMatchObject({
      phase: 'reconnecting', attempt: 1, nextRetryAt: 100_000,
    });
    expect(dependencies.random).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(supervisor.getSnapshot().a).toMatchObject({ attempt: 2, nextRetryAt: 100_250 });

    for (const delay of [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) {
      const before = connect.mock.calls.length;
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(connect).toHaveBeenCalledTimes(before);
      await jest.advanceTimersByTimeAsync(1);
      expect(connect).toHaveBeenCalledTimes(before + 1);
    }
    expect(supervisor.getSnapshot().a.nextRetryAt).toBe(Date.now() + 15_000);
  });

  it('does not churn the retry deadline or attempt counter during repeated reconciliation', async () => {
    const connect = jest.fn(async () => { throw error(); });
    const { supervisor } = create({ connect });
    await supervisor.ensure('a');
    await jest.advanceTimersByTimeAsync(0);
    const snapshot = supervisor.getSnapshot();
    for (let index = 0; index < 20; index += 1) {
      await supervisor.ensure('a');
      supervisor.setEnvironment({ online: true, foreground: true });
      supervisor.invalidate('a', error());
    }
    expect(supervisor.getSnapshot()).toBe(snapshot);
    await jest.advanceTimersByTimeAsync(250);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('keeps the failure streak until the connection is stable for ten seconds', async () => {
    const connect = jest.fn()
      .mockRejectedValueOnce(error())
      .mockResolvedValue(undefined);
    const { supervisor } = create({ connect });
    await supervisor.ensure('a');
    await jest.advanceTimersByTimeAsync(0);
    expect(supervisor.getSnapshot().a.attempt).toBe(1);
    await jest.advanceTimersByTimeAsync(9_999);
    await supervisor.ensure('a');
    expect(supervisor.getSnapshot().a.attempt).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(supervisor.getSnapshot().a.attempt).toBe(0);
  });

  it('does not count a suspended interval as stable connection time', async () => {
    const connect = jest.fn()
      .mockRejectedValueOnce(error())
      .mockResolvedValue(undefined);
    const { supervisor } = create({ connect });
    await supervisor.ensure('a');
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(9_000);
    supervisor.setEnvironment({ online: true, foreground: false });
    await jest.advanceTimersByTimeAsync(30_000);
    expect(supervisor.getSnapshot().a.attempt).toBe(1);
    supervisor.setEnvironment({ online: true, foreground: true });
    await flush();
    await jest.advanceTimersByTimeAsync(9_999);
    expect(supervisor.getSnapshot().a.attempt).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(supervisor.getSnapshot().a.attempt).toBe(0);
  });

  it('fences an invalidated pending connect and releases resources before a new attempt', async () => {
    const pending = deferred();
    const cleanup = deferred();
    const connect = jest.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const disconnect = jest.fn().mockReturnValueOnce(cleanup.promise).mockResolvedValue(undefined);
    const { supervisor } = create({ connect, disconnect });
    const first = supervisor.ensure('a');
    await flush();
    supervisor.invalidate('a', error());
    const next = supervisor.ensure('a');
    expect(connect).toHaveBeenCalledTimes(1);
    pending.resolve();
    await flush();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(supervisor.getSnapshot().a.phase).not.toBe('connected');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(1);
    cleanup.resolve();
    await expect(first).resolves.toBe(false);
    await expect(next).resolves.toBe(false);
    await jest.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not bypass backoff when an observer reconciles during failure cleanup', async () => {
    const connect = jest.fn()
      .mockRejectedValueOnce(error())
      .mockResolvedValue(undefined);
    let supervisor!: ConnectionSupervisor;
    ({ supervisor } = create({
      connect,
      onChange: () => { if (supervisor) void supervisor.ensure('a'); },
    }));
    await supervisor.ensure('a');
    await jest.advanceTimersByTimeAsync(0);
    expect(connect).toHaveBeenCalledTimes(2);
    supervisor.invalidate('a', error());
    await flush();
    expect(supervisor.getSnapshot().a).toMatchObject({ attempt: 2, nextRetryAt: 100_250 });
    expect(connect).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(250);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('recovers if a synchronous observer suspends and resumes during connection publication', async () => {
    let supervisor!: ConnectionSupervisor;
    let resumed = false;
    const probe = jest.fn(async () => {});
    ({ supervisor } = create({
      probe,
      onChange: (_id, state) => {
        if (state.phase === 'connected' && !resumed) {
          resumed = true;
          supervisor.setEnvironment({ online: true, foreground: false });
          supervisor.setEnvironment({ online: true, foreground: true });
        }
      },
    }));
    await supervisor.ensure('a');
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(supervisor.getSnapshot().a.phase).toBe('connected');
    await jest.advanceTimersByTimeAsync(15_000);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('does not race a non-abortable connect against the health-probe deadline', async () => {
    const pending = deferred();
    const { supervisor, dependencies } = create({ connect: () => pending.promise });
    const attempt = supervisor.ensure('a');
    await jest.advanceTimersByTimeAsync(60_000);
    await supervisor.checkHealth();
    expect(dependencies.disconnect).not.toHaveBeenCalled();
    expect(dependencies.probe).not.toHaveBeenCalled();
    expect(supervisor.getSnapshot().a.phase).toBe('connecting');
    pending.resolve();
    await expect(attempt).resolves.toBe(true);
  });

  it('pauses offline retries without resetting attempts and reconnects when online', async () => {
    const connect = jest.fn(async () => { throw error(); });
    const { supervisor } = create({ connect });
    await supervisor.ensure('a');
    await jest.advanceTimersByTimeAsync(0);
    supervisor.setEnvironment({ online: false, foreground: true });
    expect(supervisor.getSnapshot().a).toMatchObject({
      phase: 'waiting_network', attempt: 2, nextRetryAt: null,
    });
    await jest.advanceTimersByTimeAsync(60_000);
    await supervisor.ensure('a');
    supervisor.networkChanged();
    await supervisor.checkHealth();
    expect(connect).toHaveBeenCalledTimes(2);
    supervisor.setEnvironment({ online: true, foreground: true });
    await flush();
    expect(connect).toHaveBeenCalledTimes(3);
    expect(supervisor.getSnapshot().a.attempt).toBe(3);
  });

  it('waits for an offline pending connect to close before reconnecting on resume', async () => {
    const pending = deferred();
    const connect = jest.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const { supervisor, dependencies } = create({ connect });
    const first = supervisor.ensure('a');
    await flush();
    supervisor.setEnvironment({ online: false, foreground: true });
    supervisor.setEnvironment({ online: true, foreground: true });
    await flush();
    expect(connect).toHaveBeenCalledTimes(1);
    pending.resolve();
    await expect(first).resolves.toBe(false);
    await flush();
    expect(dependencies.disconnect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(supervisor.getSnapshot().a.phase).toBe('connected');
  });

  it('leaves fatal authentication errors latched through ensure, network and app events', async () => {
    const connect = jest.fn()
      .mockRejectedValueOnce(error('ERR_AUTHENTICATION'))
      .mockResolvedValue(undefined);
    const { supervisor } = create({ connect });
    await expect(supervisor.ensure('a')).resolves.toBe(false);
    const snapshot = supervisor.getSnapshot();
    await supervisor.ensure('a');
    supervisor.setEnvironment({ online: false, foreground: false });
    supervisor.setEnvironment({ online: true, foreground: true });
    supervisor.networkChanged();
    await supervisor.checkHealth();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(supervisor.getSnapshot()).toBe(snapshot);
    expect(connect).toHaveBeenCalledTimes(1);
    await expect(supervisor.retryNow('a')).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('allows retryFatal explicitly, but still waits for an active environment', async () => {
    const connect = jest.fn()
      .mockRejectedValueOnce(error('ERR_AUTHENTICATION'))
      .mockResolvedValue(undefined);
    const { supervisor } = create({ connect });
    await supervisor.ensure('a');
    supervisor.setEnvironment({ online: false, foreground: true });
    await expect(supervisor.ensure('a', { retryFatal: true })).resolves.toBe(false);
    expect(supervisor.getSnapshot().a.phase).toBe('waiting_network');
    supervisor.setEnvironment({ online: true, foreground: true });
    await flush();
    expect(supervisor.getSnapshot().a.phase).toBe('connected');
  });

  it('stops a deleted device and deduplicates shutdown while its connect is pending', async () => {
    const pending = deferred();
    const connect = jest.fn(() => pending.promise);
    const { supervisor, dependencies } = create({ connect });
    const attempt = supervisor.ensure('a');
    await flush();
    const removed = supervisor.remove('a');
    expect(supervisor.remove('a')).toBe(removed);
    let finished = false;
    void removed.then(() => { finished = true; });
    await flush();
    expect(finished).toBe(false);
    expect(supervisor.getSnapshot().a).toBeUndefined();
    supervisor.invalidate('a', error());
    supervisor.networkChanged();
    pending.resolve();
    await removed;
    await expect(attempt).resolves.toBe(false);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(dependencies.disconnect).toHaveBeenCalledTimes(1);
    expect(supervisor.getSnapshot().a).toBeUndefined();
  });

  it('allows explicit ensure during shutdown only after cleanup has finished', async () => {
    const cleanup = deferred();
    const disconnect = jest.fn().mockReturnValueOnce(cleanup.promise).mockResolvedValue(undefined);
    const { supervisor, dependencies } = create({ disconnect });
    await supervisor.ensure('a');
    const removed = supervisor.remove('a');
    const revived = supervisor.ensure('a');
    await flush();
    expect(dependencies.connect).toHaveBeenCalledTimes(1);
    cleanup.resolve();
    await removed;
    await expect(revived).resolves.toBe(true);
    expect(dependencies.connect).toHaveBeenCalledTimes(2);
  });

  it('a later remove cancels an ensure queued behind shutdown', async () => {
    const cleanup = deferred();
    const { supervisor, dependencies } = create({ disconnect: () => cleanup.promise });
    await supervisor.ensure('a');
    const removed = supervisor.remove('a');
    const revived = supervisor.ensure('a');
    expect(supervisor.remove('a')).toBe(removed);
    cleanup.resolve();
    await removed;
    await expect(revived).resolves.toBe(false);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(dependencies.connect).toHaveBeenCalledTimes(1);
    expect(supervisor.getSnapshot().a).toBeUndefined();
  });

  it('runs heartbeats every fifteen seconds and deduplicates manual/network probes', async () => {
    const pending = deferred();
    const probe = jest.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const { supervisor, dependencies } = create({ probe });
    await supervisor.ensure('a');
    await jest.advanceTimersByTimeAsync(14_999);
    expect(probe).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledTimes(1);
    const first = supervisor.checkHealth();
    const second = supervisor.checkHealth();
    supervisor.networkChanged();
    await expect(supervisor.ensure('a')).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(dependencies.connect).toHaveBeenCalledTimes(1);
    pending.resolve();
    await Promise.all([first, second]);
    await jest.advanceTimersByTimeAsync(15_000);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('prioritizes explicit health checks without probing on ordinary UI ensures', async () => {
    const { supervisor, dependencies } = create();
    await supervisor.ensure('a');
    const snapshot = supervisor.getSnapshot();
    for (let index = 0; index < 20; index += 1) {
      await expect(supervisor.ensure('a')).resolves.toBe(true);
    }
    expect(dependencies.probe).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await supervisor.checkHealth();
    expect(dependencies.probe).toHaveBeenCalledTimes(1);
    expect(dependencies.connect).toHaveBeenCalledTimes(1);
    expect(supervisor.getSnapshot()).toBe(snapshot);
  });

  it('diagnoses a stalled heartbeat, disconnects and fences the late successful result', async () => {
    const pending = deferred();
    const replacement = deferred();
    const connect = jest.fn().mockResolvedValueOnce(undefined).mockReturnValueOnce(replacement.promise);
    const probe = jest.fn(() => pending.promise);
    const { supervisor, dependencies } = create({ connect, probe });
    await supervisor.ensure('a');
    await jest.advanceTimersByTimeAsync(15_000);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(supervisor.getSnapshot().a).toMatchObject({
      phase: 'reconnecting', errorCode: 'ERR_BRIDGE_TIMEOUT', attempt: 1,
    });
    expect(dependencies.disconnect).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(connect).toHaveBeenCalledTimes(2);
    pending.resolve();
    await flush();
    expect(supervisor.getSnapshot().a.phase).toBe('reconnecting');
    replacement.resolve();
    await flush();
    expect(supervisor.getSnapshot().a.phase).toBe('connected');
  });

  it('handles a late rejected heartbeat after deletion without resurrecting the device', async () => {
    const pending = deferred();
    const { supervisor, dependencies } = create({ probe: () => pending.promise });
    await supervisor.ensure('a');
    const health = supervisor.checkHealth();
    await flush();
    await supervisor.remove('a');
    await health;
    pending.reject(error());
    await flush();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(supervisor.getSnapshot().a).toBeUndefined();
    expect(dependencies.connect).toHaveBeenCalledTimes(1);
  });

  it('handles a probe rejected with undefined as a failure rather than success', async () => {
    const { supervisor } = create({ probe: async () => { throw undefined; } });
    await supervisor.ensure('a');
    await supervisor.checkHealth();
    expect(supervisor.getSnapshot().a.phase).toBe('fatal');
    expect(supervisor.getSnapshot().a.errorCode).toBe('UNKNOWN');
  });

  it('releases an interrupted probe transport before reconnecting on rapid resumes', async () => {
    const oldProbe = deferred();
    const newProbe = deferred();
    const probe = jest.fn().mockReturnValueOnce(oldProbe.promise).mockReturnValueOnce(newProbe.promise);
    const { supervisor, dependencies } = create({ probe });
    await supervisor.ensure('a');
    const health = supervisor.checkHealth();
    await flush();
    supervisor.setEnvironment({ online: true, foreground: false });
    await health;
    await jest.advanceTimersByTimeAsync(60_000);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(supervisor.getSnapshot().a.phase).toBe('suspended');
    supervisor.setEnvironment({ online: true, foreground: true });
    await flush();
    oldProbe.reject(error());
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(dependencies.disconnect).toHaveBeenCalledTimes(1);
    expect(dependencies.connect).toHaveBeenCalledTimes(2);
    const replacementHealth = supervisor.checkHealth();
    await flush();
    expect(probe).toHaveBeenCalledTimes(2);
    newProbe.resolve();
    await replacementHealth;
    expect(supervisor.getSnapshot().a.phase).toBe('connected');
    await jest.advanceTimersByTimeAsync(15_000);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('rapidly toggles lifecycle state without overlapping connection or shutdown operations', async () => {
    const pending = deferred();
    const cleanup = deferred();
    const connect = jest.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const disconnect = jest.fn().mockReturnValueOnce(cleanup.promise).mockResolvedValue(undefined);
    const { supervisor } = create({ connect, disconnect });
    const first = supervisor.ensure('a');
    await flush();
    for (let index = 0; index < 5; index += 1) {
      supervisor.setEnvironment({ online: true, foreground: false });
      supervisor.setEnvironment({ online: true, foreground: true });
      supervisor.networkChanged();
      await supervisor.checkHealth();
    }
    expect(connect).toHaveBeenCalledTimes(1);
    pending.resolve();
    await flush();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    cleanup.resolve();
    await expect(first).resolves.toBe(false);
    await flush();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(supervisor.getSnapshot().a.phase).toBe('connected');
  });

  it('supports background heartbeats when the platform explicitly permits them', async () => {
    const { supervisor, dependencies } = create();
    supervisor.setEnvironment({ online: true, foreground: false, backgroundAllowed: true });
    await supervisor.ensure('a');
    await jest.advanceTimersByTimeAsync(15_000);
    expect(dependencies.probe).toHaveBeenCalledTimes(1);
    supervisor.setEnvironment({ online: true, foreground: true, backgroundAllowed: true });
    await flush();
    expect(dependencies.probe).toHaveBeenCalledTimes(2);
  });

  it('does not let one stalled heartbeat block a healthy device', async () => {
    const pending = deferred();
    const probe = jest.fn((id: string) => id === 'a' ? pending.promise : Promise.resolve());
    const { supervisor } = create({ probe });
    await Promise.all([supervisor.ensure('a'), supervisor.ensure('b')]);
    const health = supervisor.checkHealth();
    await flush();
    expect(probe).toHaveBeenCalledWith('b');
    expect(supervisor.getSnapshot().b.phase).toBe('connected');
    await jest.advanceTimersByTimeAsync(10_000);
    await health;
    expect(supervisor.getSnapshot().a.errorCode).toBe('ERR_BRIDGE_TIMEOUT');
    expect(supervisor.getSnapshot().b.phase).toBe('connected');
    pending.resolve();
  });

  it('keeps immutable external-store snapshot identity until a state actually changes', async () => {
    const { supervisor } = create();
    const listener = jest.fn();
    const unsubscribe = supervisor.subscribe(listener);
    const empty = supervisor.getSnapshot();
    expect(supervisor.getSnapshot()).toBe(empty);
    await supervisor.ensure('a');
    const connected = supervisor.getSnapshot();
    expect(connected).not.toBe(empty);
    expect(Object.isFrozen(connected)).toBe(true);
    expect(Object.isFrozen(connected.a)).toBe(true);
    const calls = listener.mock.calls.length;
    await supervisor.ensure('a');
    await supervisor.checkHealth();
    expect(supervisor.getSnapshot()).toBe(connected);
    expect(listener).toHaveBeenCalledTimes(calls);
    unsubscribe();
    supervisor.invalidate('a', error());
    expect(listener).toHaveBeenCalledTimes(calls);
    expect(connected.a.phase).toBe('connected');
  });

  it('catches synchronous dependency and observer failures', async () => {
    const { supervisor } = create({
      connect: () => { throw error(); },
      onChange: () => { throw new Error('observer failed'); },
    });
    supervisor.subscribe(() => { throw new Error('listener failed'); });
    await expect(supervisor.ensure('a')).resolves.toBe(false);
    expect(supervisor.getSnapshot().a).toMatchObject({
      phase: 'reconnecting', errorCode: 'ERR_NETWORK',
    });
  });

  it('does not reconnect over resources whose disconnect failed', async () => {
    const disconnect = jest.fn().mockRejectedValue(error('ERR_PERMISSION'));
    const { supervisor, dependencies } = create({ disconnect });
    await supervisor.ensure('a');
    supervisor.invalidate('a', error());
    await flush();
    expect(supervisor.getSnapshot().a).toMatchObject({
      phase: 'fatal', errorCode: 'ERR_PERMISSION',
    });
    await expect(supervisor.retryNow('a')).resolves.toBe(false);
    expect(dependencies.connect).toHaveBeenCalledTimes(1);
  });

  it('retains cleanup ownership after shutdown fails without restarting a stopped device', async () => {
    const disconnect = jest.fn()
      .mockRejectedValueOnce(error())
      .mockResolvedValue(undefined);
    const { supervisor, dependencies } = create({ disconnect });
    await supervisor.ensure('a');
    await expect(supervisor.remove('a')).resolves.toBeUndefined();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(supervisor.getSnapshot().a).toBeUndefined();
    expect(dependencies.connect).toHaveBeenCalledTimes(1);
    await expect(supervisor.ensure('a')).resolves.toBe(true);
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(dependencies.connect).toHaveBeenCalledTimes(2);
  });

  it('does not arm a stability timer after an observer disposes during a resume probe', async () => {
    const connect = jest.fn()
      .mockRejectedValueOnce(error())
      .mockResolvedValue(undefined);
    let supervisor!: ConnectionSupervisor;
    let disposeOnConnection = false;
    ({ supervisor } = create({
      connect,
      onChange: (_id, state) => {
        if (disposeOnConnection && state.phase === 'connected') supervisor.dispose();
      },
    }));
    await supervisor.ensure('a');
    await jest.advanceTimersByTimeAsync(0);
    supervisor.setEnvironment({ online: true, foreground: false });
    disposeOnConnection = true;
    supervisor.setEnvironment({ online: true, foreground: true });
    await flush();
    expect(supervisor.getSnapshot()).toEqual({});
    expect(jest.getTimerCount()).toBe(0);
  });

  it('disposes pending work and suppresses late callbacks until an explicit ensure', async () => {
    const pending = deferred();
    const { supervisor, dependencies } = create({ connect: () => pending.promise });
    const attempt = supervisor.ensure('a');
    await flush();
    supervisor.dispose();
    const changes = dependencies.onChange.mock.calls.length;
    pending.reject(error());
    await expect(attempt).resolves.toBe(false);
    await flush();
    await jest.advanceTimersByTimeAsync(60_000);
    supervisor.networkChanged();
    supervisor.setEnvironment({ online: false, foreground: false });
    supervisor.setEnvironment({ online: true, foreground: true });
    await supervisor.checkHealth();
    expect(supervisor.getSnapshot()).toEqual({});
    expect(dependencies.disconnect).toHaveBeenCalledTimes(1);
    expect(dependencies.onChange).toHaveBeenCalledTimes(changes);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('reuses a disposed singleton only after the previous connect and cleanup settle', async () => {
    const pending = deferred();
    const cleanup = deferred();
    const connect = jest.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const disconnect = jest.fn().mockReturnValueOnce(cleanup.promise).mockResolvedValue(undefined);
    const { supervisor } = create({ connect, disconnect });
    const oldAttempt = supervisor.ensure('a');
    await flush();
    supervisor.dispose();
    const listener = jest.fn();
    supervisor.subscribe(listener);
    const remounted = supervisor.ensure('a');
    pending.resolve();
    await flush();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(supervisor.getSnapshot().a.phase).not.toBe('connected');
    cleanup.resolve();
    await expect(oldAttempt).resolves.toBe(false);
    await expect(remounted).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalled();
    expect(supervisor.getSnapshot().a.phase).toBe('connected');
    await jest.advanceTimersByTimeAsync(15_000);
    expect(jest.getTimerCount()).toBe(1);
  });

  it('accepts the native environment signal before reusing a disposed singleton', async () => {
    const { supervisor, dependencies } = create();
    await supervisor.ensure('a');
    supervisor.dispose();
    await supervisor.remove('a');
    supervisor.setEnvironment({ online: false, foreground: true });
    await expect(supervisor.ensure('a')).resolves.toBe(false);
    expect(supervisor.getSnapshot().a.phase).toBe('waiting_network');
    expect(dependencies.connect).toHaveBeenCalledTimes(1);
    supervisor.setEnvironment({ online: true, foreground: true });
    await flush();
    expect(supervisor.getSnapshot().a.phase).toBe('connected');
    expect(dependencies.connect).toHaveBeenCalledTimes(2);
  });

  it('fences abandoned Strict Mode remounts through repeated dispose and ensure', async () => {
    const pending = deferred();
    const connect = jest.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const { supervisor, dependencies } = create({ connect });
    const original = supervisor.ensure('a');
    await flush();
    supervisor.dispose();
    const abandoned = supervisor.ensure('a');
    supervisor.dispose();
    const current = supervisor.ensure('a');
    pending.resolve();
    await expect(original).resolves.toBe(false);
    await expect(abandoned).resolves.toBe(false);
    await expect(current).resolves.toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(dependencies.disconnect).toHaveBeenCalledTimes(1);
    expect(supervisor.getSnapshot().a.phase).toBe('connected');
  });
});
