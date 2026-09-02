import { RemoteOperationError } from '@/domain/errors';
import {
  getRemoteCoreNativeModule,
  type RemoteCoreNativeModule,
} from '@/services/native-remote-client';

describe('native remote client', () => {
  const nativeModule = {
    listSessions: jest.fn(() => []),
  } as unknown as RemoteCoreNativeModule;

  it('returns the optional native module when the development build includes it', () => {
    expect(getRemoteCoreNativeModule(() => nativeModule, 'android')).toBe(nativeModule);
  });

  it('reports a rebuild action instead of crashing when the native module is missing', () => {
    expect(() => getRemoteCoreNativeModule(() => null, 'android')).toThrow(
      new RemoteOperationError({
        type: 'unknown',
        message:
          'Remote features are missing from this app build. Rebuild and reinstall the Android development app.',
      }),
    );
  });
});
