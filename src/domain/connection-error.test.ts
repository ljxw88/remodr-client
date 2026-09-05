import { classifyConnectionError, ConnectionError } from '@/domain/connection-error';
import { RemoteOperationError } from '@/domain/errors';

describe('connection error classification', () => {
  it.each(['ERR_BRIDGE_CLOSED', 'ERR_BRIDGE_TIMEOUT', 'ERR_NETWORK', 'ERR_SESSION', 'HERDR_UNAVAILABLE'])(
    'retries structured %s', (code) => {
      expect(classifyConnectionError(new ConnectionError(code, 'detail')).retryable).toBe(true);
    },
  );
  it.each(['ERR_AUTHENTICATION', 'ERR_HOST_KEY_MISMATCH', 'ERR_HOST_KEY_UNKNOWN', 'COMMAND_UNCERTAIN'])(
    'does not blindly retry %s', (code) => {
      expect(classifyConnectionError(new ConnectionError(code, 'detail')).retryable).toBe(false);
    },
  );
  it('handles existing typed native errors, not their wording', () => {
    expect(classifyConnectionError(new RemoteOperationError({
      type: 'network', message: 'Localized error',
    })).retryable).toBe(true);
    expect(classifyConnectionError(new Error('broken pipe')).retryable).toBe(false);
  });
});
