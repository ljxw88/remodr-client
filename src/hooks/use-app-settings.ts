import { useSyncExternalStore } from 'react';

import {
  DEFAULT_SETTINGS,
  settingsRepository,
  type AppSettings,
} from '@/services/settings-repository';

export function useAppSettings() {
  const settings = useSyncExternalStore<AppSettings>(
    settingsRepository.subscribe,
    settingsRepository.getSnapshot,
    () => DEFAULT_SETTINGS,
  );

  const setMarqueeEnabled = (enabled: boolean) => {
    return settingsRepository.setMarqueeEnabled(enabled);
  };

  return {
    marqueeEnabled: settings.marqueeEnabled,
    setMarqueeEnabled,
  };
}
