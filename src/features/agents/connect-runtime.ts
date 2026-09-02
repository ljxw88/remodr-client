import AsyncStorage from '@react-native-async-storage/async-storage';

import { connectHost } from '@/features/connection/connect-host';
import { refreshSessions } from '@/features/connection/use-host-session';
import { herdrRepository } from '@/services/herdr-repository';
import { hostRepository } from '@/services/host-repository';
import { remoteClient } from '@/services/native-remote-client';

let activeConnectionAttempt: Promise<boolean> | null = null;

export function connectAgentRuntime(): Promise<boolean> {
  if (activeConnectionAttempt) {
    return activeConnectionAttempt;
  }
  activeConnectionAttempt = connectAgentRuntimeOnce().finally(() => {
    activeConnectionAttempt = null;
  });
  return activeConnectionAttempt;
}

async function connectAgentRuntimeOnce(): Promise<boolean> {
  await AsyncStorage.removeItem('remote-workspace.herdr-discovery');
  await herdrRepository.hydrate();
  const existingSession = remoteClient.listSessions()[0];
  if (existingSession) {
    try {
      await herdrRepository.connect(existingSession.sessionId);
      return true;
    } catch {
      await remoteClient.disconnect(existingSession.sessionId);
      refreshSessions();
    }
  }

  const hosts = await hostRepository.list();
  const host = hosts.find(
    (candidate) =>
      candidate.credentialId && remoteClient.hasSecret(candidate.credentialId),
  );
  if (!host) {
    return false;
  }
  const session = await connectHost(host, '');
  refreshSessions();
  try {
    await herdrRepository.connect(session.sessionId);
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
