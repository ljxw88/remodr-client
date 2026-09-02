import type { HostProfile } from '@/domain/hosts';
import type { ConnectRequest, SessionSnapshot } from '@/domain/remote';
import { hostRepository } from '@/services/host-repository';
import { remoteClient } from '@/services/native-remote-client';

export async function connectHost(
  host: HostProfile,
  secret: string,
  options?: { saveSecret?: boolean; acceptedFingerprint?: string },
): Promise<SessionSnapshot> {
  let credentialId = host.credentialId;
  if (options?.saveSecret && secret) {
    credentialId = credentialId ?? `cred_${host.id}`;
    await remoteClient.saveSecret(credentialId, secret);
    if (host.credentialId !== credentialId) {
      await hostRepository.update(host.id, {
        name: host.name,
        hostname: host.hostname,
        port: host.port,
        username: host.username,
        authType: host.authType,
        credentialId,
        favorite: host.favorite,
        group: host.group,
        jumpHostIds: host.jumpHostIds,
      });
    }
  }

  const jumpHops = await resolveJumpHops(host);
  const request: ConnectRequest = {
    hostId: host.id,
    hostname: host.hostname,
    port: host.port,
    username: host.username,
    credentialId,
    credentialType: host.authType,
    acceptedHostKeyFingerprint: options?.acceptedFingerprint,
    jumpHops,
  };
  if (host.authType === 'privateKey') {
    request.privateKey = secret || undefined;
  } else {
    request.password = secret || undefined;
  }
  return remoteClient.connect(request);
}

async function resolveJumpHops(host: HostProfile): Promise<ConnectRequest[]> {
  const hops: ConnectRequest[] = [];
  for (const id of host.jumpHostIds ?? []) {
    const jump = await hostRepository.get(id);
    if (!jump) {
      continue;
    }
    hops.push({
      hostId: jump.id,
      hostname: jump.hostname,
      port: jump.port,
      username: jump.username,
      credentialId: jump.credentialId,
      credentialType: jump.authType,
    });
  }
  return hops;
}
