import AsyncStorage from '@react-native-async-storage/async-storage';

import { ConnectionError } from '@/domain/connection-error';
import {
  connectAgentRuntime, connectionSupervisor, disconnectDeviceRuntime, stopConnectionRuntime,
} from '@/features/agents/connect-runtime';
import { ensureHostConnected } from '@/features/connection/saved-host-connector';
import { herdrRepository } from '@/services/herdr-repository';
import { hostRepository } from '@/services/host-repository';
import { remoteClient } from '@/services/native-remote-client';

jest.mock('@/features/connection/saved-host-connector', () => ({
  ensureHostConnected: jest.fn(), invalidateHostConnection: jest.fn(),
}));
jest.mock('@/features/connection/use-host-session', () => ({ refreshSessions: jest.fn() }));
jest.mock('@/services/herdr-repository', () => ({
  herdrRepository: {
    hydrate: jest.fn(), connect: jest.fn(), releaseDevice: jest.fn(),
    selectDevice: jest.fn(), getSnapshot: jest.fn(), setConnectionState: jest.fn(),
    setConnectionObserver: jest.fn(), setReconnectHandler: jest.fn(),
    flushCommands: jest.fn(), probeDevice: jest.fn(),
  },
}));
jest.mock('@/services/host-repository', () => ({ hostRepository: { list: jest.fn() } }));
jest.mock('@/services/native-remote-client', () => ({
  remoteClient: { getSession: jest.fn(), hasSecret: jest.fn(), disconnectHost: jest.fn() },
}));

const host = {
  id: 'device-1', name: 'One', hostname: 'example.com', port: 22, username: 'user',
  authType: 'password' as const, credentialId: 'secret-1',
  createdAt: '2026-01-01', updatedAt: '2026-01-01',
};

describe('connection runtime adapter', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    stopConnectionRuntime();
    await Promise.resolve();
    jest.clearAllMocks();
    await AsyncStorage.clear();
    jest.mocked(hostRepository.list).mockResolvedValue([host]);
    jest.mocked(remoteClient.getSession).mockReturnValue(null);
    jest.mocked(remoteClient.hasSecret).mockReturnValue(true);
    jest.mocked(remoteClient.disconnectHost).mockResolvedValue();
    jest.mocked(herdrRepository.hydrate).mockResolvedValue();
    jest.mocked(herdrRepository.releaseDevice).mockResolvedValue();
    jest.mocked(herdrRepository.connect).mockResolvedValue();
    jest.mocked(herdrRepository.flushCommands).mockResolvedValue();
    jest.mocked(herdrRepository.probeDevice).mockResolvedValue();
    jest.mocked(herdrRepository.getSnapshot).mockReturnValue({ selectedDeviceId: null } as ReturnType<typeof herdrRepository.getSnapshot>);
    jest.mocked(ensureHostConnected).mockImplementation(async (target) => ({
      sessionId: `ssh-${target.id}`, hostId: target.id, status: 'connected',
    }));
    connectionSupervisor.setEnvironment({ foreground: true, online: true });
  });
  afterEach(async () => {
    stopConnectionRuntime();
    await Promise.resolve();
    jest.useRealTimers();
  });

  it('hydrates existing disabled preferences before a startup-time user action writes them', async () => {
    await AsyncStorage.setItem('remote-workspace.herdr.disabled-devices', JSON.stringify(['disabled-A']));
    await disconnectDeviceRuntime('disabled-B');
    expect(JSON.parse((await AsyncStorage.getItem('remote-workspace.herdr.disabled-devices'))!))
      .toEqual(expect.arrayContaining(['disabled-A', 'disabled-B']));
  });

  it('connects all devices without a failing device blocking a healthy device', async () => {
    jest.mocked(hostRepository.list).mockResolvedValue([host, { ...host, id: 'device-2' }]);
    jest.mocked(ensureHostConnected).mockRejectedValueOnce(new ConnectionError('ERR_NETWORK', 'offline'));
    await expect(connectAgentRuntime()).resolves.toBe(true);
    expect(herdrRepository.connect).toHaveBeenCalledWith('ssh-device-2', 'device-2');
  });

  it('coalesces overlapping requests to the same device', async () => {
    await Promise.all([connectAgentRuntime(host.id), connectAgentRuntime(host.id)]);
    expect(ensureHostConnected).toHaveBeenCalledTimes(1);
    expect(herdrRepository.connect).toHaveBeenCalledTimes(1);
  });

  it('does not restart an already healthy connection', async () => {
    await connectAgentRuntime(host.id);
    await connectAgentRuntime(host.id);
    expect(herdrRepository.connect).toHaveBeenCalledTimes(1);
  });

  it('automatic recovery does not switch the selected device', async () => {
    jest.mocked(hostRepository.list).mockResolvedValue([host, { ...host, id: 'device-2' }]);
    await connectAgentRuntime(host.id);
    herdrRepository.selectDevice('device-2');
    jest.mocked(herdrRepository.selectDevice).mockClear();
    await connectionSupervisor.retryNow(host.id);
    expect(herdrRepository.selectDevice).not.toHaveBeenCalled();
  });

  it('explicit disconnect suppresses further automatic reconnects', async () => {
    await connectAgentRuntime(host.id);
    await disconnectDeviceRuntime(host.id);
    jest.mocked(herdrRepository.connect).mockClear();
    connectionSupervisor.networkChanged();
    await jest.advanceTimersByTimeAsync(60_000);
    await expect(connectAgentRuntime()).resolves.toBe(false);
    expect(herdrRepository.connect).not.toHaveBeenCalled();
    // An explicit connect re-enables the device.
    await expect(connectAgentRuntime(host.id)).resolves.toBe(true);
  });
});
