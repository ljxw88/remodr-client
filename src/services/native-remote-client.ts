import { Platform } from 'react-native';

import { parseRemoteError, RemoteOperationError } from '@/domain/errors';
import type {
  CommandResult,
  ConnectRequest,
  RemoteClient,
  RemoteFile,
  SessionSnapshot,
  TunnelSnapshot,
} from '@/domain/remote';

export type RemoteCoreNativeModule = {
  connect(options: Record<string, unknown>): Promise<SessionSnapshot>;
  disconnect(sessionId: string): Promise<void>;
  disconnectHost(hostId: string): Promise<void>;
  getSession(hostId: string): SessionSnapshot | null;
  listSessions(): SessionSnapshot[];
  startHerdrBridge(sessionId: string): Promise<{
    bridgeId: string;
    hello: string;
  }>;
  requestHerdrBridge(bridgeId: string, requestJson: string): Promise<string>;
  stopHerdrBridge(bridgeId: string): Promise<void>;
  exec(sessionId: string, command: string): Promise<CommandResult>;
  openPty(sessionId: string, cols: number, rows: number): Promise<string>;
  writePty(ptyId: string, data: string): Promise<void>;
  resizePty(ptyId: string, cols: number, rows: number): Promise<void>;
  closePty(ptyId: string): Promise<void>;
  sftpList(sessionId: string, path: string): Promise<RemoteFile[]>;
  sftpMkdir(sessionId: string, path: string): Promise<void>;
  sftpRename(sessionId: string, from: string, to: string): Promise<void>;
  sftpRemove(sessionId: string, path: string): Promise<void>;
  sftpDownload(sessionId: string, remotePath: string, localPath: string): Promise<void>;
  sftpUpload(sessionId: string, localPath: string, remotePath: string): Promise<void>;
  openLocalForward(
    sessionId: string,
    bindHost: string,
    bindPort: number,
    destHost: string,
    destPort: number,
  ): Promise<TunnelSnapshot>;
  closeForward(tunnelId: string): Promise<void>;
  listForwards(sessionId: string): TunnelSnapshot[];
  saveSecret(id: string, secret: string): Promise<void>;
  hasSecret(id: string): boolean;
  deleteSecret(id: string): Promise<void>;
  listKnownHosts(): { hostname: string; port: number; fingerprint: string }[];
  removeKnownHost(hostname: string, port: number): Promise<void>;
  addListener(event: string, listener: (event: SessionSnapshot) => void): { remove(): void };
};

export function getRemoteCoreNativeModule(): RemoteCoreNativeModule {
  if (Platform.OS !== 'android') {
    throw new RemoteOperationError({
      type: 'unknown',
      message: 'SSH connectivity is only available on Android.',
    });
  }
  // Local Expo module autolinked as RemoteCore
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../../modules/remote-core').default as RemoteCoreNativeModule;
}

function wrap<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw new RemoteOperationError(parseRemoteError(error));
  }
}

async function wrapAsync<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new RemoteOperationError(parseRemoteError(error));
  }
}

function hopPayload(hop: ConnectRequest): Record<string, unknown> {
  return {
    hostId: hop.hostId,
    hostname: hop.hostname,
    port: hop.port,
    username: hop.username,
    password: hop.password,
    privateKey: hop.privateKey,
    passphrase: hop.passphrase,
    credentialId: hop.credentialId,
    credentialType: hop.credentialType,
    acceptedHostKeyFingerprint: hop.acceptedHostKeyFingerprint,
  };
}

export const remoteClient: RemoteClient = {
  connect(request) {
    return wrapAsync(() =>
      getRemoteCoreNativeModule().connect({
        ...hopPayload(request),
        jumpHops: request.jumpHops?.map(hopPayload) ?? [],
      }),
    );
  },
  disconnect(sessionId) {
    return wrapAsync(() => getRemoteCoreNativeModule().disconnect(sessionId));
  },
  disconnectHost(hostId) {
    return wrapAsync(() => getRemoteCoreNativeModule().disconnectHost(hostId));
  },
  getSession(hostId) {
    return wrap(() => getRemoteCoreNativeModule().getSession(hostId));
  },
  listSessions() {
    return wrap(() => getRemoteCoreNativeModule().listSessions());
  },
  exec(sessionId, command) {
    return wrapAsync(() => getRemoteCoreNativeModule().exec(sessionId, command));
  },
  openPty(sessionId, cols, rows) {
    return wrapAsync(() => getRemoteCoreNativeModule().openPty(sessionId, cols, rows));
  },
  writePty(ptyId, data) {
    return wrapAsync(() => getRemoteCoreNativeModule().writePty(ptyId, data));
  },
  resizePty(ptyId, cols, rows) {
    return wrapAsync(() => getRemoteCoreNativeModule().resizePty(ptyId, cols, rows));
  },
  closePty(ptyId) {
    return wrapAsync(() => getRemoteCoreNativeModule().closePty(ptyId));
  },
  sftpList(sessionId, path) {
    return wrapAsync(() => getRemoteCoreNativeModule().sftpList(sessionId, path));
  },
  sftpMkdir(sessionId, path) {
    return wrapAsync(() => getRemoteCoreNativeModule().sftpMkdir(sessionId, path));
  },
  sftpRename(sessionId, from, to) {
    return wrapAsync(() => getRemoteCoreNativeModule().sftpRename(sessionId, from, to));
  },
  sftpRemove(sessionId, path) {
    return wrapAsync(() => getRemoteCoreNativeModule().sftpRemove(sessionId, path));
  },
  sftpDownload(sessionId, remotePath, localPath) {
    return wrapAsync(() => getRemoteCoreNativeModule().sftpDownload(sessionId, remotePath, localPath));
  },
  sftpUpload(sessionId, localPath, remotePath) {
    return wrapAsync(() => getRemoteCoreNativeModule().sftpUpload(sessionId, localPath, remotePath));
  },
  openLocalForward(sessionId, bindHost, bindPort, destHost, destPort) {
    return wrapAsync(() => getRemoteCoreNativeModule().openLocalForward(sessionId, bindHost, bindPort, destHost, destPort));
  },
  closeForward(tunnelId) {
    return wrapAsync(() => getRemoteCoreNativeModule().closeForward(tunnelId));
  },
  listForwards(sessionId) {
    return wrap(() => getRemoteCoreNativeModule().listForwards(sessionId));
  },
  saveSecret(id, secret) {
    return wrapAsync(() => getRemoteCoreNativeModule().saveSecret(id, secret));
  },
  hasSecret(id) {
    return wrap(() => getRemoteCoreNativeModule().hasSecret(id));
  },
  deleteSecret(id) {
    return wrapAsync(() => getRemoteCoreNativeModule().deleteSecret(id));
  },
  listKnownHosts() {
    return wrap(() => getRemoteCoreNativeModule().listKnownHosts());
  },
  removeKnownHost(hostname, port) {
    return wrapAsync(() => getRemoteCoreNativeModule().removeKnownHost(hostname, port));
  },
};
