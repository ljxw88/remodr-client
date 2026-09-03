import type { HostProfile } from '@/domain/hosts';
import type { SessionSnapshot } from '@/domain/remote';
import { connectHost } from '@/features/connection/connect-host';
import { refreshSessions } from '@/features/connection/use-host-session';
import { hostRepository } from '@/services/host-repository';
import { remoteClient } from '@/services/native-remote-client';

type Dependencies = {
  listHosts(): Promise<HostProfile[]>;
  getSession(hostId: string): SessionSnapshot | null;
  hasSecret(credentialId: string): boolean;
  connect(
    host: HostProfile,
    acceptedFingerprint?: string,
  ): Promise<SessionSnapshot>;
  disconnect(sessionId: string): Promise<void>;
  refreshSessions(): void;
  reportFailure(host: HostProfile, error: unknown): void;
};

export function createSavedHostConnector(dependencies: Dependencies) {
  const inFlight = new Map<string, Promise<SessionSnapshot>>();
  const generations = new Map<string, number>();
  let autoConnectAttempt: Promise<void> | null = null;

  function invalidateHostConnection(hostId: string) {
    generations.set(hostId, (generations.get(hostId) ?? 0) + 1);
  }

  function ensureHostConnected(
    host: HostProfile,
    acceptedFingerprint?: string,
  ): Promise<SessionSnapshot> {
    const existing = dependencies.getSession(host.id);
    if (existing) {
      dependencies.refreshSessions();
      return Promise.resolve(existing);
    }
    const active = inFlight.get(host.id);
    if (active) {
      return active;
    }
    const generation = generations.get(host.id) ?? 0;
    const attempt = dependencies
      .connect(host, acceptedFingerprint)
      .then(async (session) => {
        if ((generations.get(host.id) ?? 0) !== generation) {
          await dependencies.disconnect(session.sessionId);
          throw new HostConnectionInvalidatedError();
        }
        dependencies.refreshSessions();
        return session;
      })
      .finally(() => {
        inFlight.delete(host.id);
      });
    inFlight.set(host.id, attempt);
    return attempt;
  }

  function autoConnectSavedHosts(): Promise<void> {
    if (autoConnectAttempt) {
      return autoConnectAttempt;
    }
    const attempt = dependencies
      .listHosts()
      .then(async (hosts) => {
        const eligible = hosts.filter(
          (host) =>
            host.credentialId &&
            dependencies.hasSecret(host.credentialId) &&
            !dependencies.getSession(host.id),
        );
        const results = await Promise.allSettled(
          eligible.map((host) => ensureHostConnected(host)),
        );
        results.forEach((result, index) => {
          if (result.status === 'rejected') {
            if (result.reason instanceof HostConnectionInvalidatedError) {
              return;
            }
            dependencies.reportFailure(eligible[index], result.reason);
          }
        });
      })
      .finally(() => {
        if (autoConnectAttempt === attempt) {
          autoConnectAttempt = null;
        }
      });
    autoConnectAttempt = attempt;
    return attempt;
  }

  return {
    autoConnectSavedHosts,
    ensureHostConnected,
    invalidateHostConnection,
  };
}

class HostConnectionInvalidatedError extends Error {
  constructor() {
    super('Saved host connection was cancelled.');
    this.name = 'HostConnectionInvalidatedError';
  }
}

const savedHostConnector = createSavedHostConnector({
  listHosts: () => hostRepository.list(),
  getSession: (hostId) => remoteClient.getSession(hostId),
  hasSecret: (credentialId) => remoteClient.hasSecret(credentialId),
  connect: (host, acceptedFingerprint) =>
    connectHost(host, '', { acceptedFingerprint }),
  disconnect: (sessionId) => remoteClient.disconnect(sessionId),
  refreshSessions,
  reportFailure: (host, error) => {
    console.warn(`[SSH] Could not auto-connect ${host.name}`, error);
  },
});

export const {
  autoConnectSavedHosts,
  ensureHostConnected,
  invalidateHostConnection,
} = savedHostConnector;
