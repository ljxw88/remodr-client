import { extractFingerprint, parseRemoteError } from '@/domain/errors';

describe('remote errors', () => {
  it('extracts SHA256 fingerprints', () => {
    expect(extractFingerprint('Untrusted host key SHA256:abcDEF123')).toBe('SHA256:abcDEF123');
  });

  it('maps host key codes', () => {
    const error = parseRemoteError({ code: 'ERR_HOST_KEY_UNKNOWN', message: 'Untrusted host key SHA256:abc' });
    expect(error.type).toBe('hostKeyUnknown');
    if (error.type === 'hostKeyUnknown') {
      expect(error.fingerprint).toBe('SHA256:abc');
    }
  });

  it('does not expose native crypto errors', () => {
    expect(
      parseRemoteError({
        code: 'ERR_CRYPTO_PROVIDER',
        message: 'no such algorithm: X25519 for provider BC',
      }),
    ).toEqual({
      type: 'crypto',
      message: 'SSH security could not be initialized. Rebuild and restart the app.',
    });
  });
});
