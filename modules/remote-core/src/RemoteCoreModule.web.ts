import { registerWebModule, NativeModule } from 'expo';

import { RemoteCoreModuleEvents } from './RemoteCore.types';

// RemoteCoreModule is not available on the web platform.
class RemoteCoreModule extends NativeModule<RemoteCoreModuleEvents> {}

export default registerWebModule(RemoteCoreModule, 'RemoteCoreModule');
