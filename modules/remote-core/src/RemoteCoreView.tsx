import { requireNativeView } from 'expo';
import * as React from 'react';

import { RemoteCoreViewProps } from './RemoteCore.types';

const NativeView: React.ComponentType<RemoteCoreViewProps> = requireNativeView('RemoteCore');

export default function RemoteCoreView(props: RemoteCoreViewProps) {
  return <NativeView {...props} />;
}
