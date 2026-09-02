import AsyncStorage from '@react-native-async-storage/async-storage';

import { connectHost } from '@/features/connection/connect-host';
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
  const existingSession = requestedHost
    ? remoteClient.getSession(requestedHost.id)
    : remoteClient.listSessions()[0];
  const host =
    requestedHost ??
    (existingSession
      ? hosts.find((candidate) => candidate.id === existingSession.hostId)
      : undefined) ??
    hosts.find(
      (candidate) =>
        candidate.credentialId && remoteClient.hasSecret(candidate.credentialId),
    );
  if (!host) {
    return false;
  }
  herdrRepository.selectDevice(host.id);
  await AsyncStorage.setItem(SELECTED_DEVICE_KEY, host.id);

  if (existingSession) {
    try {
      await herdrRepository.connect(existingSession.sessionId, host.id);
      return true;
    } catch {
      await remoteClient.disconnect(existingSession.sessionId);
      refreshSessions();
    }
  }

  if (!host.credentialId || !remoteClient.hasSecret(host.credentialId)) {
    return false;
  }
  const session = await connectHost(host, '');
  refreshSessions();
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
