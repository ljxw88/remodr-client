export const REWARD_PRODUCTS = [
  { id: 'com.remodr.reward.small', label: 'Small thanks', fallbackPrice: '$1.99' },
  { id: 'com.remodr.reward.medium', label: 'Nice support', fallbackPrice: '$4.99' },
  { id: 'com.remodr.reward.large', label: 'Big thanks', fallbackPrice: '$9.99' },
] as const;

export type RewardProductId = (typeof REWARD_PRODUCTS)[number]['id'];
