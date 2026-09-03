import AsyncStorage from '@react-native-async-storage/async-storage';

import type { HostProfile } from '@/domain/hosts';
import { ensureHostConnected } from '@/features/connection/saved-host-connector';
import { refreshSessions } from '@/features/connection/use-host-session';
import { herdrRepository } from '@/services/herdr-repository';
import { hostRepository } from '@/services/host-repository';
import { remoteClient } from '@/services/native-remote-client';

const SELECTED_DEVICE_KEY = 'remote-workspace.herdr.selected-device';

/** One in-flight attempt per device, so devices never block each other. */
const attempts = new Map<string, Promise<boolean>>();

function connectDevice(host: HostProfile): Promise<boolean> {
  const active = attempts.get(host.id);
  if (active) {
    return active;
  }
  const attempt = connectDeviceOnce(host).finally(() => {
    if (attempts.get(host.id) === attempt) {
      attempts.delete(host.id);
    }
  });
  attempts.set(host.id, attempt);
  return attempt;
}

async function connectDeviceOnce(host: HostProfile): Promise<boolean> {
  const existingSession = remoteClient.getSession(host.id);
  if (existingSession) {
    try {
      await herdrRepository.connect(existingSession.sessionId, host.id);
      refreshSessions();
      return true;
    } catch {
      await remoteClient.disconnect(existingSession.sessionId);
      refreshSessions();
    }
  }
  if (!host.credentialId || !remoteClient.hasSecret(host.credentialId)) {
    return false;
  }
  const session = await ensureHostConnected(host);
  try {
    await herdrRepository.connect(session.sessionId, host.id);
    return true;
  } catch (error) {
    try {
      await remoteClient.disconnect(session.sessionId);
    } catch (cleanupError) {
      console.warn('[HERDR_RUNTIME] Could not release failed SSH session', cleanupError);
    }
    refreshSessions();
    throw error;
  }
}

async function selectDevice(deviceId: string): Promise<void> {
  herdrRepository.selectDevice(deviceId);
  await AsyncStorage.setItem(SELECTED_DEVICE_KEY, deviceId);
}

/**
 * Connects one device, or every eligible device when no device is given.
 * Each device keeps its own bridge, so a later switch needs no reconnect.
 */
export async function connectAgentRuntime(deviceId?: string): Promise<boolean> {
  await herdrRepository.hydrate();
  const hosts = await hostRepository.list();

  if (deviceId) {
    const host = hosts.find((candidate) => candidate.id === deviceId);
    if (!host) {
      return false;
    }
    await selectDevice(host.id);
    if (herdrRepository.isDeviceConnected(host.id)) {
      return true;
    }
    return connectDevice(host);
  }

  const eligible = hosts.filter(
    (host) =>
      remoteClient.getSession(host.id) ||
      (host.credentialId && remoteClient.hasSecret(host.credentialId)),
  );
  if (eligible.length === 0) {
    return false;
  }

  const storedDeviceId = await AsyncStorage.getItem(SELECTED_DEVICE_KEY);
  const preferred =
    eligible.find((host) => host.id === storedDeviceId) ??
    eligible.find((host) => remoteClient.getSession(host.id)) ??
    eligible[0];
  await selectDevice(preferred.id);

  const results = await Promise.allSettled(eligible.map((host) => connectDevice(host)));
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.warn(
        `[HERDR_RUNTIME] Could not connect ${eligible[index].name}`,
        result.reason,
      );
    }
  });
  return results.some((result) => result.status === 'fulfilled' && result.value);
}
