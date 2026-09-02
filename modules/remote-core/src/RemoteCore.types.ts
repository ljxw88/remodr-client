import type { StyleProp, ViewStyle } from 'react-native';

export type RemoteCoreModuleEvents = {
  onSessionChange: (params: {
    sessionId: string;
    hostId: string;
    status: string;
    fingerprint?: string;
  }) => void;
  onHerdrMessage: (params: {
    bridgeId: string;
    message: string;
  }) => void;
};

export type RemoteCoreViewProps = {
  style?: StyleProp<ViewStyle>;
  ptyId?: string | null;
  cols?: number;
  rows?: number;
};
