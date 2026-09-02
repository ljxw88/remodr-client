import type { CreateHostInput, HostProfile } from '@/domain/hosts';
import { hostRepository } from '@/services/host-repository';
import { remoteClient } from '@/services/native-remote-client';

type HostLifecycleDependencies = {
  disconnectHost(hostId: string): Promise<void>;
  deleteSecret(credentialId: string): Promise<void>;
  removeHost(hostId: string): Promise<void>;
  updateHost(hostId: string, input: CreateHostInput): Promise<HostProfile>;
};

const defaultDependencies: HostLifecycleDependencies = {
  disconnectHost: (hostId) => remoteClient.disconnectHost(hostId),
  deleteSecret: (credentialId) => remoteClient.deleteSecret(credentialId),
  removeHost: (hostId) => hostRepository.remove(hostId),
  updateHost: (hostId, input) => hostRepository.update(hostId, input),
};

export async function deleteHost(
  host: HostProfile,
  dependencies: HostLifecycleDependencies = defaultDependencies,
): Promise<void> {
  await dependencies.disconnectHost(host.id);
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
  const updated = await dependencies.updateHost(host.id, {
    ...input,
    credentialId: authenticationChanged ? undefined : host.credentialId,
  });
  if (authenticationChanged && host.credentialId) {
    await dependencies.deleteSecret(host.credentialId);
  }
  return updated;
}
