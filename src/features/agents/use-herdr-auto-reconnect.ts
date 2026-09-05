import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';

import { connectAgentRuntime } from '@/features/agents/connect-runtime';
import { herdrRepository } from '@/services/herdr-repository';

/**
 * Proactively supervises the Herdr connection across the app.
 *
 * 1. Automatically triggers reconnect when returning to foreground from another app.
 * 2. Proactively retries connecting if the runtime drops into an error or disconnected state.
 */
export function useHerdrAutoReconnect() {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectingRef = useRef(false);

  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }

    const tryReconnect = async () => {
      if (reconnectingRef.current) {
        return;
      }
      reconnectingRef.current = true;
      try {
        await connectAgentRuntime();
      } catch (error) {
        console.warn('[HERDR_AUTO_RECONNECT] Proactive reconnect attempt failed', error);
      } finally {
        reconnectingRef.current = false;
      }
    };

    // Reconnect whenever app comes to foreground
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void tryReconnect();
      }
    });

    // Supervise connection status and retry automatically
    const scheduleRetryIfNeeded = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const snapshot = herdrRepository.getSnapshot();
      const needsReconnect =
        snapshot.connection === 'disconnected' ||
        snapshot.connection === 'error' ||
        snapshot.connection === 'reconnecting';

      if (needsReconnect && AppState.currentState === 'active') {
        timerRef.current = setTimeout(() => {
          void tryReconnect();
        }, 4000);
      }
    };

    const repoSub = herdrRepository.subscribe(scheduleRetryIfNeeded);
    scheduleRetryIfNeeded();

    return () => {
      appStateSub.remove();
      repoSub();
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);
}
