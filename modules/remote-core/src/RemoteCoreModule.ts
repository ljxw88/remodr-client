import { NativeModule, requireNativeModule } from 'expo';

import { RemoteCoreModuleEvents } from './RemoteCore.types';

declare class RemoteCoreModule extends NativeModule<RemoteCoreModuleEvents> {
  connect(options: Record<string, unknown>): Promise<Record<string, unknown>>;
  disconnect(sessionId: string): Promise<void>;
  disconnectHost(hostId: string): Promise<void>;
  getSession(hostId: string): Record<string, unknown> | null;
  listSessions(): Record<string, unknown>[];
  startHerdrBridge(sessionId: string): Promise<{
    bridgeId: string;
    hello: string;
  }>;
  requestHerdrBridge(bridgeId: string, requestJson: string): Promise<string>;
  stopHerdrBridge(bridgeId: string): Promise<void>;
  exec(sessionId: string, command: string): Promise<Record<string, unknown>>;
  openPty(sessionId: string, cols: number, rows: number): Promise<string>;
  writePty(ptyId: string, data: string): Promise<void>;
  resizePty(ptyId: string, cols: number, rows: number): Promise<void>;
  closePty(ptyId: string): Promise<void>;
  sftpList(sessionId: string, path: string): Promise<Record<string, unknown>[]>;
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
  ): Promise<Record<string, unknown>>;
  closeForward(tunnelId: string): Promise<void>;
  listForwards(sessionId: string): Record<string, unknown>[];
  saveSecret(id: string, secret: string): Promise<void>;
  hasSecret(id: string): boolean;
  deleteSecret(id: string): Promise<void>;
  listKnownHosts(): Record<string, unknown>[];
  removeKnownHost(hostname: string, port: number): Promise<void>;
}

export default requireNativeModule<RemoteCoreModule>('RemoteCore');
