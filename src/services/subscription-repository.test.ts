import {
  SUBSCRIPTION_STORAGE_KEY,
  SubscriptionRepository,
} from '@/services/subscription-repository';

describe('SubscriptionRepository', () => {
  let mockStore: Record<string, string>;
  let getItem: jest.Mock<Promise<string | null>, [string]>;
  let repository: SubscriptionRepository;

  beforeEach(() => {
    mockStore = {};
    getItem = jest.fn(async (key: string) => mockStore[key] ?? null);
    repository = new SubscriptionRepository({
      getItem,
      setItem: jest.fn(async (key: string, value: string) => {
        mockStore[key] = value;
      }),
    });
  });

  it('loads a valid persisted development entitlement', async () => {
    mockStore[SUBSCRIPTION_STORAGE_KEY] = JSON.stringify({
      tier: 'pro',
      expiresAt: null,
    });

    await expect(repository.init()).resolves.toEqual({
      tier: 'pro',
      expiresAt: null,
      isPro: true,
    });
  });

  it('ignores malformed persisted state', async () => {
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockStore[SUBSCRIPTION_STORAGE_KEY] = JSON.stringify({
      tier: 'pro',
      expiresAt: 'not-a-date',
    });

    try {
      await expect(repository.init()).resolves.toEqual({
        tier: 'free',
        expiresAt: null,
        isPro: false,
      });
    } finally {
      warning.mockRestore();
    }
  });

  it('expires time-limited entitlements when loading', async () => {
    mockStore[SUBSCRIPTION_STORAGE_KEY] = JSON.stringify({
      tier: 'pro',
      expiresAt: '2020-01-01T00:00:00.000Z',
    });

    await expect(repository.init()).resolves.toEqual({
      tier: 'free',
      expiresAt: null,
      isPro: false,
    });
  });

  it('shares one storage read between concurrent initialization calls', async () => {
    await Promise.all([repository.init(), repository.init()]);

    expect(getItem).toHaveBeenCalledTimes(1);
  });
});
