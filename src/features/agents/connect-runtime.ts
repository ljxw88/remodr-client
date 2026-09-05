import AsyncStorage from '@react-native-async-storage/async-storage';

import { classifyConnectionError, ConnectionError } from '@/domain/connection-error';
import { ConnectionSupervisor } from '@/features/connection/connection-supervisor';
import { ensureHostConnected, invalidateHostConnection } from '@/features/connection/saved-host-connector';
import { refreshSessions } from '@/features/connection/use-host-session';
import { herdrRepository } from '@/services/herdr-repository';
import { hostRepository } from '@/services/host-repository';
import { remoteClient } from '@/services/native-remote-client';

const SELECTED_DEVICE_KEY = 'remote-workspace.herdr.selected-device';
const DISABLED_DEVICES_KEY = 'remote-workspace.herdr.disabled-devices';
const disabled = new Set<string>();
let started = false;
let starting: Promise<void> | null = null;
let lifecycleGeneration = 0;
let savingDisabled: Promise<void> = Promise.resolve();
let disabledHydration: Promise<void> | null = null;

function hydrateDisabled(): Promise<void> {
  if (!disabledHydration) {
    disabledHydration = AsyncStorage.getItem(DISABLED_DEVICES_KEY).then((raw) => {
      if (!raw) return;
      const saved: unknown = JSON.parse(raw);
      if (!Array.isArray(saved) || saved.some((id) => typeof id !== 'string')) {
        throw new Error('Saved device connection settings are invalid.');
      }
      saved.forEach((id: string) => disabled.add(id));
    }).catch((error) => {
      disabledHydration = null;
      throw error;
    });
  }
  return disabledHydration;
}

async function release(deviceId: string) {
  invalidateHostConnection(deviceId);
  try {
    await herdrRepository.releaseDevice(deviceId);
  } finally {
    await remoteClient.disconnectHost(deviceId);
    refreshSessions();
  }
}

export const connectionSupervisor = new ConnectionSupervisor({
  async connect(deviceId) {
    const host = (await hostRepository.list()).find((entry) => entry.id === deviceId);
    if (!host || disabled.has(deviceId)) throw new ConnectionError('DEVICE_REMOVED', 'Device is not enabled.');
    let session = remoteClient.getSession(deviceId);
    if (!session) {
      if (!host.credentialId || !remoteClient.hasSecret(host.credentialId)) {
        throw new ConnectionError('ERR_AUTHENTICATION', 'Sign in to this server to reconnect.');
      }
      session = await ensureHostConnected(host);
    }
    await herdrRepository.connect(session.sessionId, deviceId);
    refreshSessions();
  },
  disconnect: release,
  probe: (deviceId) => herdrRepository.probeDevice(deviceId),
  classify: classifyConnectionError,
  onChange(deviceId, state) {
    const connection = state.phase === 'connected' ? 'connected'
      : state.phase === 'fatal' ? 'error'
        : state.phase === 'connecting' ? 'connecting'
          : state.phase === 'disconnected' || state.phase === 'suspended' ? 'disconnected' : 'reconnecting';
    herdrRepository.setConnectionState(deviceId, connection, state.lastError);
    if (state.phase === 'connected') {
      void herdrRepository.flushCommands(deviceId).catch((error) => {
        console.warn('[OUTBOX] Could not process the saved queue', error);
      });
    }
  },
});

// The repository reports failures; only the supervisor owns reconnect attempts.
herdrRepository.setConnectionObserver((deviceId, error) => {
  if (disabled.has(deviceId)) return;
  // A late native event must never revive a device removed during teardown.
  connectionSupervisor.invalidate(deviceId, error);
});
herdrRepository.setReconnectHandler((deviceId) =>
  disabled.has(deviceId) ? Promise.resolve(false) : connectionSupervisor.ensure(deviceId));

function persistDisabled() {
  const value = JSON.stringify([...disabled]);
  const operation = savingDisabled.then(() => AsyncStorage.setItem(DISABLED_DEVICES_KEY, value));
  savingDisabled = operation.catch((error) => {
    console.warn('[CONNECTION] Could not save disabled devices', error);
  });
  return operation;
}

export async function disconnectDeviceRuntime(deviceId: string) {
  disabled.add(deviceId);
  try {
    await hydrateDisabled();
    await persistDisabled();
  } finally {
    await connectionSupervisor.remove(deviceId);
    // A manually authenticated SSH session may predate supervisor ownership.
    await release(deviceId);
  }
}

export async function retryDeviceConnection(deviceId: string): Promise<boolean> {
  await hydrateDisabled();
  disabled.delete(deviceId);
  await persistDisabled();
  return connectionSupervisor.retryNow(deviceId);
}

/** Selection is user intent; automatic recovery never changes it. */
export async function connectAgentRuntime(deviceId?: string): Promise<boolean> {
  return requestConnections(deviceId);
}

async function requestConnections(deviceId?: string, generation?: number): Promise<boolean> {
  await hydrateDisabled();
  await herdrRepository.hydrate();
  const hosts = await hostRepository.list();
  if (generation !== undefined && generation !== lifecycleGeneration) return false;
  if (deviceId) {
    if (!hosts.some((host) => host.id === deviceId)) return false;
    herdrRepository.selectDevice(deviceId);
    await AsyncStorage.setItem(SELECTED_DEVICE_KEY, deviceId);
    disabled.delete(deviceId);
    await persistDisabled();
    if (generation !== undefined && generation !== lifecycleGeneration) return false;
    return connectionSupervisor.ensure(deviceId, { retryFatal: true });
  }
  const eligible = hosts.filter((host) => !disabled.has(host.id) &&
    (remoteClient.getSession(host.id) || (host.credentialId && remoteClient.hasSecret(host.credentialId))));
  if (!eligible.length) return false;
  if (!herdrRepository.getSnapshot().selectedDeviceId) {
    const stored = await AsyncStorage.getItem(SELECTED_DEVICE_KEY);
    const preferred = eligible.find((host) => host.id === stored) ?? eligible[0];
    herdrRepository.selectDevice(preferred.id);
    await AsyncStorage.setItem(SELECTED_DEVICE_KEY, preferred.id);
  }
  if (generation !== undefined && generation !== lifecycleGeneration) return false;
  const results = await Promise.all(eligible.map((host) => connectionSupervisor.ensure(host.id)));
  return results.some(Boolean);
}

export function startConnectionRuntime(): Promise<void> {
  if (starting) return starting;
  if (started) return Promise.resolve();
  const generation = lifecycleGeneration;
  const attempt = (async () => {
    await hydrateDisabled();
    if (generation !== lifecycleGeneration) return;
    started = true;
    await requestConnections(undefined, generation);
  })().catch((error) => {
    started = false;
    throw error;
  }).finally(() => {
    if (starting === attempt) starting = null;
  });
  starting = attempt;
  return attempt;
}

export function stopConnectionRuntime() {
  started = false;
  starting = null;
  lifecycleGeneration++;
  connectionSupervisor.dispose();
}
