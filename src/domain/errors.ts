export type RemoteError =
  | { type: 'network'; message: string }
  | { type: 'authentication'; message: string }
  | { type: 'hostKeyUnknown'; message: string; fingerprint: string }
  | { type: 'hostKeyMismatch'; message: string; fingerprint?: string }
  | { type: 'crypto'; message: string }
  | { type: 'timeout'; message: string }
  | { type: 'unknown'; message: string };

export class RemoteOperationError extends Error {
  readonly remoteError: RemoteError;

  constructor(remoteError: RemoteError) {
    super(remoteError.message);
    this.name = 'RemoteOperationError';
    this.remoteError = remoteError;
  }
}

const FINGERPRINT_PATTERN = /SHA256:[A-Za-z0-9+/=]+/;

export function extractFingerprint(message: string): string | undefined {
  return message.match(FINGERPRINT_PATTERN)?.[0];
}

export function parseRemoteError(error: unknown): RemoteError {
  const code = getErrorCode(error);
  const message = getErrorMessage(error);
  const fingerprint = extractFingerprint(message);

  switch (code) {
    case 'ERR_HOST_KEY_UNKNOWN':
      return {
        type: 'hostKeyUnknown',
        message: 'This host key is not trusted yet.',
        fingerprint: fingerprint ?? '',
      };
    case 'ERR_HOST_KEY_MISMATCH':
      return {
        type: 'hostKeyMismatch',
        message: 'The SSH host key does not match the stored fingerprint.',
        fingerprint,
      };
    case 'ERR_AUTHENTICATION':
      return { type: 'authentication', message: 'Authentication failed.' };
    case 'ERR_NETWORK':
      return { type: 'network', message: 'Could not reach the server.' };
    case 'ERR_TIMEOUT':
      return { type: 'timeout', message: 'The connection timed out.' };
    case 'ERR_CRYPTO_PROVIDER':
      return {
        type: 'crypto',
        message: 'SSH security could not be initialized. Rebuild and restart the app.',
      };
    case 'ERR_SSH_CONNECTION':
      return { type: 'network', message: 'SSH negotiation failed.' };
    default:
      if (message.includes('only available on Android')) {
        return { type: 'unknown', message: 'SSH connectivity is only available on Android.' };
      }
      return { type: 'unknown', message: message || 'Unable to connect.' };
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error == null) {
    return undefined;
  }
  if ('code' in error && typeof error.code === 'string') {
    return error.code;
  }
  if ('cause' in error) {
    return getErrorCode(error.cause);
  }
  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'object' && error != null && 'message' in error && typeof error.message === 'string') {
    return error.message;
  }
  return '';
}
