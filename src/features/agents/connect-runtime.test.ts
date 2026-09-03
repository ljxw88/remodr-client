import AsyncStorage from '@react-native-async-storage/async-storage';

import { connectAgentRuntime } from '@/features/agents/connect-runtime';
import { ensureHostConnected } from '@/features/connection/saved-host-connector';
import { refreshSessions } from '@/features/connection/use-host-session';
import { herdrRepository } from '@/services/herdr-repository';
import { hostRepository } from '@/services/host-repository';
import { remoteClient } from '@/services/native-remote-client';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(),
    removeItem: jest.fn(),
    setItem: jest.fn(),
  },
}));
jest.mock('@/features/connection/saved-host-connector', () => ({
  ensureHostConnected: jest.fn(),
}));
jest.mock('@/features/connection/use-host-session', () => ({
  refreshSessions: jest.fn(),
}));
jest.mock('@/services/herdr-repository', () => ({
  herdrRepository: {
    hydrate: jest.fn(),
    connect: jest.fn(),
    selectDevice: jest.fn(),
  },
}));
jest.mock('@/services/host-repository', () => ({
  hostRepository: {
    list: jest.fn(),
  },
}));
jest.mock('@/services/native-remote-client', () => ({
  remoteClient: {
    listSessions: jest.fn(),
    getSession: jest.fn(),
    hasSecret: jest.fn(),
    disconnect: jest.fn(),
  },
}));

describe('connectAgentRuntime', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(AsyncStorage.removeItem).mockResolvedValue();
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    jest.mocked(AsyncStorage.setItem).mockResolvedValue();
    jest.mocked(herdrRepository.hydrate).mockResolvedValue();
    jest.mocked(remoteClient.listSessions).mockReturnValue([]);
    jest.mocked(remoteClient.getSession).mockReturnValue(null);
    jest.mocked(remoteClient.disconnect).mockResolvedValue();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('disconnects a newly opened SSH session when Herdr startup fails', async () => {
    const host = {
      id: 'host-1',
      name: 'Server',
      hostname: 'server.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password' as const,
      credentialId: 'credential-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    jest.mocked(hostRepository.list).mockResolvedValue([host]);
    jest.mocked(remoteClient.hasSecret).mockReturnValue(true);
    jest.mocked(ensureHostConnected).mockResolvedValue({
      sessionId: 'session-1',
      hostId: host.id,
      status: 'connected',
    });
    jest.mocked(herdrRepository.connect).mockRejectedValue(new Error('bridge failed'));
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(connectAgentRuntime()).rejects.toThrow('bridge failed');

    expect(herdrRepository.selectDevice).toHaveBeenCalledWith(host.id);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'remote-workspace.herdr.selected-device',
      host.id,
    );
    expect(herdrRepository.connect).toHaveBeenCalledWith('session-1', host.id);
    expect(remoteClient.disconnect).toHaveBeenCalledWith('session-1');
    expect(refreshSessions).toHaveBeenCalledTimes(1);
  });

  it('falls back to another saved host when the first host cannot connect', async () => {
    const first = {
      id: 'host-1',
      name: 'Unavailable',
      hostname: 'offline.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password' as const,
      credentialId: 'credential-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const second = {
      ...first,
      id: 'host-2',
      name: 'Available',
      hostname: 'online.example.com',
      credentialId: 'credential-2',
    };
    jest.mocked(hostRepository.list).mockResolvedValue([first, second]);
    jest.mocked(remoteClient.hasSecret).mockReturnValue(true);
    jest
      .mocked(ensureHostConnected)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        sessionId: 'session-2',
        hostId: second.id,
        status: 'connected',
      });
    jest.mocked(herdrRepository.connect).mockResolvedValue();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(connectAgentRuntime()).resolves.toBe(true);

    expect(ensureHostConnected).toHaveBeenNthCalledWith(1, first);
    expect(ensureHostConnected).toHaveBeenNthCalledWith(2, second);
    expect(herdrRepository.connect).toHaveBeenCalledWith('session-2', second.id);
  });

  it('refreshes session consumers when reusing an existing native session', async () => {
    const host = {
      id: 'host-1',
      name: 'Connected',
      hostname: 'online.example.com',
      port: 22,
      username: 'ubuntu',
      authType: 'password' as const,
      credentialId: 'credential-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const existing = {
      sessionId: 'session-1',
      hostId: host.id,
      status: 'connected' as const,
    };
    jest.mocked(hostRepository.list).mockResolvedValue([host]);
    jest.mocked(remoteClient.getSession).mockReturnValue(existing);
    jest.mocked(herdrRepository.connect).mockResolvedValue();

    await expect(connectAgentRuntime(host.id)).resolves.toBe(true);

    expect(ensureHostConnected).not.toHaveBeenCalled();
    expect(herdrRepository.connect).toHaveBeenCalledWith(existing.sessionId, host.id);
    expect(refreshSessions).toHaveBeenCalledTimes(1);
  });
});
