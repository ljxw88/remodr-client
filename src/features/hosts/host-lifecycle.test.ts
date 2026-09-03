import type { CreateHostInput, HostProfile } from '@/domain/hosts';
import { deleteHost, updateHost } from '@/features/hosts/host-lifecycle';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {},
}));

const host: HostProfile = {
  id: 'host-1',
  name: 'Server',
  hostname: 'server.example.com',
  port: 22,
  username: 'ubuntu',
  authType: 'password',
  credentialId: 'credential-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function dependencies() {
  return {
    disconnectHost: jest.fn(async () => undefined),
    deleteSecret: jest.fn(async () => undefined),
    removeHost: jest.fn(async () => undefined),
    updateHost: jest.fn(async (_id: string, input: CreateHostInput) => ({
      ...host,
      ...input,
    })),
    invalidateHostConnection: jest.fn(),
  };
}

describe('host lifecycle', () => {
  it('releases the session and credential before deleting host metadata', async () => {
    const deps = dependencies();

    await deleteHost(host, deps);

    expect(deps.disconnectHost).toHaveBeenCalledWith(host.id);
    expect(deps.invalidateHostConnection).toHaveBeenCalledWith(host.id);
    expect(deps.deleteSecret).toHaveBeenCalledWith(host.credentialId);
    expect(deps.disconnectHost).toHaveBeenCalledWith(host.id);
    expect(deps.removeHost).toHaveBeenCalledWith(host.id);
    expect(deps.disconnectHost.mock.invocationCallOrder[0]).toBeLessThan(
      deps.deleteSecret.mock.invocationCallOrder[0],
    );
    expect(deps.deleteSecret.mock.invocationCallOrder[0]).toBeLessThan(
      deps.removeHost.mock.invocationCallOrder[0],
    );
  });

  it('clears an incompatible saved credential when authentication changes', async () => {
    const deps = dependencies();

    await updateHost(host, { ...host, authType: 'privateKey' }, deps);

    expect(deps.deleteSecret).toHaveBeenCalledWith(host.credentialId);
    expect(deps.updateHost).toHaveBeenCalledWith(
      host.id,
      expect.objectContaining({
        authType: 'privateKey',
        credentialId: undefined,
      }),
    );
    expect(deps.updateHost.mock.invocationCallOrder[0]).toBeLessThan(
      deps.deleteSecret.mock.invocationCallOrder[0],
    );
  });

  it('keeps a compatible credential when authentication is unchanged', async () => {
    const deps = dependencies();

    await updateHost(host, { ...host, name: 'Renamed' }, deps);

    expect(deps.deleteSecret).not.toHaveBeenCalled();
    expect(deps.disconnectHost).not.toHaveBeenCalled();
    expect(deps.updateHost).toHaveBeenCalledWith(
      host.id,
      expect.objectContaining({ credentialId: host.credentialId }),
    );
  });

  it('keeps the saved credential when the metadata update fails', async () => {
    const deps = dependencies();
    deps.updateHost.mockRejectedValue(new Error('storage unavailable'));

    await expect(
      updateHost(host, { ...host, authType: 'privateKey' }, deps),
    ).rejects.toThrow('storage unavailable');

    expect(deps.deleteSecret).not.toHaveBeenCalled();
  });
});
