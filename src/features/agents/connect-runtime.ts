import AsyncStorage from '@react-native-async-storage/async-storage';

import type { HostProfile } from '@/domain/hosts';
import { ensureHostConnected } from '@/features/connection/saved-host-connector';
import { refreshSessions } from '@/features/connection/use-host-session';
import { herdrRepository } from '@/services/herdr-repository';
import { hostRepository } from '@/services/host-repository';
import { remoteClient } from '@/services/native-remote-client';

let activeConnectionAttempt: Promise<boolean> | null = null;
let activeDeviceId: string | undefined;
const SELECTED_DEVICE_KEY = 'remote-workspace.herdr.selected-device';

export function connectAgentRuntime(deviceId?: string): Promise<boolean> {
  if (activeConnectionAttempt && activeDeviceId === deviceId) {
    return activeConnectionAttempt;
  }
  const previous = activeConnectionAttempt;
  const attempt = previous
    ? previous.catch(() => false).then(() => connectAgentRuntimeOnce(deviceId))
    : connectAgentRuntimeOnce(deviceId);
  activeDeviceId = deviceId;
  const trackedAttempt = attempt.finally(() => {
    if (activeConnectionAttempt === trackedAttempt) {
      activeConnectionAttempt = null;
      activeDeviceId = undefined;
    }
  });
  activeConnectionAttempt = trackedAttempt;
  return activeConnectionAttempt;
}

async function connectAgentRuntimeOnce(preferredDeviceId?: string): Promise<boolean> {
  await AsyncStorage.removeItem('remote-workspace.herdr-discovery');
  await herdrRepository.hydrate();
  const hosts = await hostRepository.list();
  const storedDeviceId = await AsyncStorage.getItem(SELECTED_DEVICE_KEY);
  const requestedDeviceId = preferredDeviceId ?? storedDeviceId ?? undefined;
  const requestedHost = requestedDeviceId
    ? hosts.find((candidate) => candidate.id === requestedDeviceId)
    : undefined;
  if (preferredDeviceId && !requestedHost) {
    return false;
  }

  const candidates: typeof hosts = [];
  const addCandidate = (host: (typeof hosts)[number] | undefined) => {
    if (host && !candidates.some((candidate) => candidate.id === host.id)) {
      candidates.push(host);
    }
  };
  addCandidate(requestedHost);
  if (!preferredDeviceId) {
    for (const session of remoteClient.listSessions()) {
      addCandidate(hosts.find((host) => host.id === session.hostId));
    }
    for (const host of hosts) {
      if (host.credentialId && remoteClient.hasSecret(host.credentialId)) {
        addCandidate(host);
      }
    }
  }

  let lastError: unknown;
  for (const host of candidates) {
    try {
      if (await connectRuntimeForHost(host)) {
        return true;
      }
    } catch (error) {
      lastError = error;
      if (preferredDeviceId) {
        throw error;
      }
      console.warn(`[HERDR_RUNTIME] Could not connect ${host.name}`, error);
    }
  }
  if (lastError) {
    throw lastError;
  }
  return false;
}

async function connectRuntimeForHost(host: HostProfile): Promise<boolean> {
  herdrRepository.selectDevice(host.id);
  await AsyncStorage.setItem(SELECTED_DEVICE_KEY, host.id);
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
