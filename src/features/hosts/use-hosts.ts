import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import type { HostProfile } from '@/domain/hosts';
import { hostRepository } from '@/services/host-repository';
import { toUserMessage } from '@/utils/user-error';

export function useHosts() {
  const [hosts, setHosts] = useState<HostProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await hostRepository.list();
      setHosts(next);
      setError(null);
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  return { hosts, loading, error, reload };
}
