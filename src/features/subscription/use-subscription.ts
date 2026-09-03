import { useSyncExternalStore } from 'react';

import {
  DEFAULT_SUBSCRIPTION_STATE,
  getAgentQuota,
  getDeviceQuota,
  type PlanTier,
  type SubscriptionState,
} from '@/domain/subscription';
import { totalDeviceAgentCount } from '@/domain/herdr';
import { useHerdr } from '@/features/agents/use-herdr';
import { useHosts } from '@/features/hosts/use-hosts';
import { subscriptionRepository } from '@/services/subscription-repository';

export function useSubscription() {
  const subscription = useSyncExternalStore<SubscriptionState>(
    subscriptionRepository.subscribe,
    subscriptionRepository.getSnapshot,
    () => DEFAULT_SUBSCRIPTION_STATE,
  );

  const { hosts } = useHosts();
  const herdr = useHerdr();

  const deviceCount = hosts.length;
  // Agent counts come from each device's live runtime.
  const activeAgentCount = totalDeviceAgentCount(herdr.agentCountsByDevice);
  const isPro = __DEV__ && subscription.isPro;

  const deviceQuota = getDeviceQuota(deviceCount, isPro);
  const agentQuota = getAgentQuota(activeAgentCount, isPro);

  const setDevelopmentTier = async (tier: PlanTier) => {
    if (!__DEV__) {
      throw new Error('Development subscription overrides are unavailable.');
    }
    return await subscriptionRepository.setTier(tier);
  };

  const upgradeToPro = async () => {
    return await setDevelopmentTier('pro');
  };

  const downgradeToFree = async () => {
    return await setDevelopmentTier('free');
  };

  const restorePurchases = async (): Promise<boolean> => {
    if (!__DEV__) {
      return false;
    }
    const restored = await subscriptionRepository.init();
    return restored.isPro;
  };

  return {
    tier: isPro ? 'pro' : 'free',
    isPro,
    expiresAt: isPro ? subscription.expiresAt : null,
    deviceQuota,
    agentQuota,
    upgradeToPro,
    downgradeToFree,
    restorePurchases,
  };
}
