import { RemoteOperationError } from '@/domain/errors';

export type ConnectionFailure = {
  code: string;
  message: string;
  retryable: boolean;
};

export class ConnectionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'ConnectionError';
  }
}

export function connectionErrorCode(error: unknown): string {
  if (error instanceof RemoteOperationError) {
    const codes = {
      network: 'ERR_NETWORK',
      timeout: 'ERR_TIMEOUT',
      authentication: 'ERR_AUTHENTICATION',
      hostKeyUnknown: 'ERR_HOST_KEY_UNKNOWN',
      hostKeyMismatch: 'ERR_HOST_KEY_MISMATCH',
      crypto: 'ERR_CRYPTO_PROVIDER',
      unknown: 'UNKNOWN',
    };
    return codes[error.remoteError.type];
  }
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'UNKNOWN';
}

const RETRYABLE = new Set([
  'ERR_NETWORK', 'ERR_TIMEOUT', 'ERR_SSH_CONNECTION', 'ERR_BRIDGE_CLOSED',
  'ERR_BRIDGE_TIMEOUT', 'ERR_SESSION', 'ERR_SESSION_NOT_FOUND', 'BRIDGE_NOT_STARTED', 'BRIDGE_CLOSED',
  'HERDR_UNAVAILABLE', 'NETWORK_UNAVAILABLE',
]);

export function classifyConnectionError(error: unknown): ConnectionFailure {
  const code = connectionErrorCode(error);
  return {
    code,
    message: error instanceof Error ? error.message : 'Connection failed.',
    // Unknown/protocol/permission errors must not become an infinite retry loop.
    retryable: RETRYABLE.has(code),
  };
}
