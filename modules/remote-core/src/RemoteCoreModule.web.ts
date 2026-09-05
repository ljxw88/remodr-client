import { registerWebModule, NativeModule } from 'expo';

import { RemoteCoreModuleEvents } from './RemoteCore.types';

// RemoteCoreModule is not available on the web platform.
class RemoteCoreModule extends NativeModule<RemoteCoreModuleEvents> {
  async getConnectionServiceEligibility() {
    return { eligible: false, reason: 'unavailable' };
  }

  async setConnectionService(_active: boolean, _label: string): Promise<boolean> {
    return false;
  }
}

export default registerWebModule(RemoteCoreModule, 'RemoteCoreModule');
