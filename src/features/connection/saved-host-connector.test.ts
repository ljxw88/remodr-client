import type { HostProfile } from '@/domain/hosts';
import type { SessionSnapshot } from '@/domain/remote';
import { createSavedHostConnector } from '@/features/connection/saved-host-connector';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {},
}));

const hosts: HostProfile[] = [
  {
    id: 'host-1',
    name: 'Primary',
    hostname: 'primary.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    credentialId: 'credential-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'host-2',
    name: 'Secondary',
    hostname: 'secondary.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    credentialId: 'credential-2',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

function session(hostId: string): SessionSnapshot {
  return {
    sessionId: `session-${hostId}`,
    hostId,
    status: 'connected',
  };
}

describe('saved host connector', () => {
  it('auto-connects every disconnected host with a saved credential', async () => {
    const connect = jest.fn(async (host: HostProfile) => session(host.id));
    const refreshSessions = jest.fn();
    const connector = createSavedHostConnector({
      listHosts: async () => hosts,
      getSession: () => null,
      hasSecret: () => true,
      connect,
      disconnect: jest.fn(),
      refreshSessions,
      reportFailure: jest.fn(),
    });

    await connector.autoConnectSavedHosts();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(connect).toHaveBeenCalledWith(hosts[0], undefined);
    expect(connect).toHaveBeenCalledWith(hosts[1], undefined);
    expect(refreshSessions).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent connection attempts for one host', async () => {
    let resolveConnection: ((value: SessionSnapshot) => void) | undefined;
    const connect = jest.fn(
      () =>
        new Promise<SessionSnapshot>((resolve) => {
          resolveConnection = resolve;
        }),
    );
    const connector = createSavedHostConnector({
      listHosts: async () => hosts,
      getSession: () => null,
      hasSecret: () => true,
      connect,
      disconnect: jest.fn(),
      refreshSessions: jest.fn(),
      reportFailure: jest.fn(),
    });

    const first = connector.ensureHostConnected(hosts[0]);
    const second = connector.ensureHostConnected(hosts[0]);
    resolveConnection?.(session(hosts[0].id));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('skips connected hosts and hosts without saved credentials', async () => {
    const connect = jest.fn(async (host: HostProfile) => session(host.id));
    const connector = createSavedHostConnector({
      listHosts: async () => [
        hosts[0],
        { ...hosts[1], credentialId: undefined },
      ],
      getSession: (hostId) => (hostId === hosts[0].id ? session(hostId) : null),
      hasSecret: () => true,
      connect,
      disconnect: jest.fn(),
      refreshSessions: jest.fn(),
      reportFailure: jest.fn(),
    });

    await connector.autoConnectSavedHosts();

    expect(connect).not.toHaveBeenCalled();
  });

  it('disconnects a session that finishes after its host was invalidated', async () => {
    let resolveConnection: ((value: SessionSnapshot) => void) | undefined;
    const disconnect = jest.fn(async () => undefined);
    const connector = createSavedHostConnector({
      listHosts: async () => hosts,
      getSession: () => null,
      hasSecret: () => true,
      connect: () =>
        new Promise<SessionSnapshot>((resolve) => {
          resolveConnection = resolve;
        }),
      disconnect,
      refreshSessions: jest.fn(),
      reportFailure: jest.fn(),
    });

    const attempt = connector.ensureHostConnected(hosts[0]);
    connector.invalidateHostConnection(hosts[0].id);
    resolveConnection?.(session(hosts[0].id));

    await expect(attempt).rejects.toThrow('cancelled');
    expect(disconnect).toHaveBeenCalledWith(`session-${hosts[0].id}`);
  });
});
