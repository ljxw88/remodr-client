export type SessionStatus = 'disconnected' | 'connecting' | 'connected';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface SessionSnapshot {
  sessionId: string;
  hostId: string;
  status: SessionStatus;
  fingerprint?: string;
}

export interface ConnectRequest {
  hostId: string;
  hostname: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  credentialId?: string;
  credentialType?: 'password' | 'privateKey';
  acceptedHostKeyFingerprint?: string;
  jumpHops?: ConnectRequest[];
}

export interface RemoteFile {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified?: number;
}

export interface TunnelSnapshot {
  id: string;
  bindHost: string;
  bindPort: number;
  destHost: string;
  destPort: number;
}

export interface RemoteClient {
  connect(request: ConnectRequest): Promise<SessionSnapshot>;
  disconnect(sessionId: string): Promise<void>;
  disconnectHost(hostId: string): Promise<void>;
  getSession(hostId: string): SessionSnapshot | null;
  listSessions(): SessionSnapshot[];
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
}

export interface RemoteSession {
  id: string;
  exec(command: string): Promise<CommandResult>;
  openTerminal(): Promise<string>;
  disconnect(): Promise<void>;
}
