export type NativeSessionSnapshot = {
  sessionId: string;
  hostId: string;
  status: 'disconnected' | 'connecting' | 'connected';
  fingerprint?: string;
};

export type NativeCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type NativeRemoteFile = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified?: number;
};

export type NativeTunnelSnapshot = {
  id: string;
  bindHost: string;
  bindPort: number;
  destHost: string;
  destPort: number;
};

export type NativeKnownHost = {
  hostname: string;
  port: number;
  fingerprint: string;
};

export type NativeConnectionServiceEligibility = {
  eligible: boolean;
  reason?: string;
};

export type RemoteCoreModuleEvents = {
  onConnectionServiceChange: (params: {
    active: boolean;
    reason?: string;
  }) => void;
  onSessionChange: (params: NativeSessionSnapshot) => void;
  onHerdrMessage: (params: {
    bridgeId: string;
    message: string;
  }) => void;
};
