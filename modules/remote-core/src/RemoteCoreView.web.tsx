import { RemoteCoreViewProps } from './RemoteCore.types';

// RemoteCoreView is not available on the web platform.
export default function RemoteCoreView(_props: RemoteCoreViewProps) {
  throw new Error('RemoteCoreView is not available on the web platform.');
}
