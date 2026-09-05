import { NativeModule, requireNativeModule } from 'expo';

import type {
  NativeCommandResult,
  NativeConnectionServiceEligibility,
  NativeKnownHost,
  NativeRemoteFile,
  NativeSessionSnapshot,
  NativeTunnelSnapshot,
  RemoteCoreModuleEvents,
} from './RemoteCore.types';

declare class RemoteCoreModule extends NativeModule<RemoteCoreModuleEvents> {
  /** Does not request notification permission; the caller owns the permission UX. */
  getConnectionServiceEligibility(): Promise<NativeConnectionServiceEligibility>;
  /** Starts only with a resumed Activity. Returns actual service state, not SSH health. */
  setConnectionService(active: boolean, label: string): Promise<boolean>;
  connect(options: Record<string, unknown>): Promise<NativeSessionSnapshot>;
  disconnect(sessionId: string): Promise<void>;
  disconnectHost(hostId: string): Promise<void>;
  getSession(hostId: string): NativeSessionSnapshot | null;
  listSessions(): NativeSessionSnapshot[];
  startHerdrBridge(sessionId: string): Promise<{
    bridgeId: string;
    hello: string;
  }>;
  requestHerdrBridge(bridgeId: string, requestJson: string): Promise<string>;
  stopHerdrBridge(bridgeId: string): Promise<void>;
  exec(sessionId: string, command: string): Promise<NativeCommandResult>;
  sftpList(sessionId: string, path: string): Promise<NativeRemoteFile[]>;
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
  ): Promise<NativeTunnelSnapshot>;
  closeForward(tunnelId: string): Promise<void>;
  listForwards(sessionId: string): NativeTunnelSnapshot[];
  saveSecret(id: string, secret: string): Promise<void>;
  hasSecret(id: string): boolean;
  deleteSecret(id: string): Promise<void>;
  listKnownHosts(): NativeKnownHost[];
  removeKnownHost(hostname: string, port: number): Promise<void>;
}

export default requireNativeModule<RemoteCoreModule>('RemoteCore');
