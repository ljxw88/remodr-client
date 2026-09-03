import { z } from 'zod';

export const planTierSchema = z.enum(['free', 'pro']);
export type PlanTier = z.infer<typeof planTierSchema>;

export const persistedSubscriptionStateSchema = z.object({
  tier: planTierSchema,
  expiresAt: z.iso.datetime({ offset: true }).nullable().default(null),
});
export type PersistedSubscriptionState = z.infer<
  typeof persistedSubscriptionStateSchema
>;

export const FREE_TIER_LIMITS = {
  maxDevices: 1,
} as const;

export type SubscriptionState = {
  tier: PlanTier;
  expiresAt: string | null;
  isPro: boolean;
};

export const DEFAULT_SUBSCRIPTION_STATE: SubscriptionState = {
  tier: 'free',
  expiresAt: null,
  isPro: false,
};

export function canAddDevice(currentDeviceCount: number, isPro: boolean): boolean {
  if (isPro) return true;
  return currentDeviceCount < FREE_TIER_LIMITS.maxDevices;
}

export function canStartAgent(_currentActiveAgentCount: number, _isPro: boolean): boolean {
  return true;
}

export function getDeviceQuota(currentDeviceCount: number, isPro: boolean) {
  return {
    used: currentDeviceCount,
    limit: isPro ? Infinity : FREE_TIER_LIMITS.maxDevices,
    isLimitReached: !canAddDevice(currentDeviceCount, isPro),
    label: isPro ? `${currentDeviceCount} (Unlimited)` : `${currentDeviceCount}/${FREE_TIER_LIMITS.maxDevices}`,
  };
}

export function getAgentQuota(currentActiveAgentCount: number, _isPro: boolean) {
  return {
    used: currentActiveAgentCount,
    limit: Infinity,
    isLimitReached: false,
    label: `${currentActiveAgentCount} (Unlimited)`,
  };
}
