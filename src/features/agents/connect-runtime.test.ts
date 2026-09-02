import AsyncStorage from '@react-native-async-storage/async-storage';

import { connectAgentRuntime } from '@/features/agents/connect-runtime';
import { connectHost } from '@/features/connection/connect-host';
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
jest.mock('@/features/connection/connect-host', () => ({
  connectHost: jest.fn(),
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
    jest.mocked(AsyncStorage.removeItem).mockResolvedValue();
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    jest.mocked(AsyncStorage.setItem).mockResolvedValue();
    jest.mocked(herdrRepository.hydrate).mockResolvedValue();
    jest.mocked(remoteClient.listSessions).mockReturnValue([]);
    jest.mocked(hostRepository.list).mockResolvedValue([host]);
    jest.mocked(remoteClient.hasSecret).mockReturnValue(true);
    jest.mocked(connectHost).mockResolvedValue({
      sessionId: 'session-1',
      hostId: host.id,
      status: 'connected',
    });
    jest.mocked(herdrRepository.connect).mockRejectedValue(new Error('bridge failed'));
    jest.mocked(remoteClient.disconnect).mockResolvedValue();

    await expect(connectAgentRuntime()).rejects.toThrow('bridge failed');

    expect(herdrRepository.selectDevice).toHaveBeenCalledWith(host.id);
    expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      'remote-workspace.herdr.selected-device',
      host.id,
    );
    expect(herdrRepository.connect).toHaveBeenCalledWith('session-1', host.id);
    expect(remoteClient.disconnect).toHaveBeenCalledWith('session-1');
    expect(refreshSessions).toHaveBeenCalledTimes(2);
  });
});
