import type { CreateHostInput, HostProfile } from '@/domain/hosts';
import { invalidateHostConnection } from '@/features/connection/saved-host-connector';
import { hostRepository } from '@/services/host-repository';
import { remoteClient } from '@/services/native-remote-client';
import { disconnectDeviceRuntime } from '@/features/agents/connect-runtime';
import { herdrRepository } from '@/services/herdr-repository';

type HostLifecycleDependencies = {
  disconnectHost(hostId: string): Promise<void>;
  deleteSecret(credentialId: string): Promise<void>;
  removeHost(hostId: string): Promise<void>;
  updateHost(hostId: string, input: CreateHostInput): Promise<HostProfile>;
  invalidateHostConnection(hostId: string): void;
  cancelCommands?(hostId: string): Promise<void>;
};

const defaultDependencies: HostLifecycleDependencies = {
  disconnectHost: async (hostId) => {
    await disconnectDeviceRuntime(hostId);
    await remoteClient.disconnectHost(hostId);
  },
  deleteSecret: (credentialId) => remoteClient.deleteSecret(credentialId),
  removeHost: async (hostId) => {
    await hostRepository.remove(hostId);
    await herdrRepository.disconnectDevice(hostId);
  },
  updateHost: (hostId, input) => hostRepository.update(hostId, input),
  invalidateHostConnection,
  cancelCommands: (hostId) => herdrRepository.cancelDeviceCommands(hostId),
};

export async function deleteHost(
  host: HostProfile,
  dependencies: HostLifecycleDependencies = defaultDependencies,
): Promise<void> {
  dependencies.invalidateHostConnection(host.id);
  await dependencies.disconnectHost(host.id);
  await dependencies.cancelCommands?.(host.id);
  if (host.credentialId) {
    await dependencies.deleteSecret(host.credentialId);
  }
  await dependencies.removeHost(host.id);
}

export async function updateHost(
  host: HostProfile,
  input: CreateHostInput,
  dependencies: HostLifecycleDependencies = defaultDependencies,
): Promise<HostProfile> {
  const authenticationChanged = host.authType !== input.authType;
  const connectionChanged = authenticationChanged || host.hostname !== input.hostname ||
    host.port !== input.port || host.username !== input.username ||
    JSON.stringify(host.jumpHostIds ?? []) !== JSON.stringify(input.jumpHostIds ?? []);
  if (connectionChanged) {
    dependencies.invalidateHostConnection(host.id);
    await dependencies.disconnectHost(host.id);
    await dependencies.cancelCommands?.(host.id);
  }
  const updated = await dependencies.updateHost(host.id, {
    ...input,
    credentialId: authenticationChanged ? undefined : host.credentialId,
  });
  if (authenticationChanged && host.credentialId) {
    await dependencies.deleteSecret(host.credentialId);
  }
  return updated;
}
