import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DEFAULT_SUBSCRIPTION_STATE,
  persistedSubscriptionStateSchema,
  type PlanTier,
  type PersistedSubscriptionState,
  type SubscriptionState,
} from '@/domain/subscription';

export const SUBSCRIPTION_STORAGE_KEY = 'remote-workspace.subscription.v1';

type Listener = () => void;
type KeyValueStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export class SubscriptionRepository {
  private state: SubscriptionState = { ...DEFAULT_SUBSCRIPTION_STATE };
  private listeners = new Set<Listener>();
  private loaded = false;
  private initPromise: Promise<SubscriptionState> | null = null;

  constructor(private readonly storage: KeyValueStorage = AsyncStorage) {}

  init(): Promise<SubscriptionState> {
    if (this.loaded) {
      return Promise.resolve(this.state);
    }
    this.initPromise ??= this.load();
    return this.initPromise;
  }

  private async load(): Promise<SubscriptionState> {
    try {
      const raw = await this.storage.getItem(SUBSCRIPTION_STORAGE_KEY);
      if (raw) {
        const parsed = persistedSubscriptionStateSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          this.state = toSubscriptionState(parsed.data);
        } else {
          console.warn('[SUBSCRIPTION] Ignored invalid subscription state');
        }
      }
    } catch (error) {
      console.warn('[SUBSCRIPTION] Failed to load subscription state', error);
    } finally {
      this.loaded = true;
      this.notify();
    }
    return this.state;
  }

  getSnapshot = (): SubscriptionState => {
    return this.state;
  };

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    if (!this.loaded) {
      void this.init();
    }
    return () => {
      this.listeners.delete(listener);
    };
  };

  async setTier(tier: PlanTier, expiresAt: string | null = null): Promise<SubscriptionState> {
    const persisted = persistedSubscriptionStateSchema.parse({ tier, expiresAt });
    const nextState = toSubscriptionState(persisted);
    try {
      await this.storage.setItem(
        SUBSCRIPTION_STORAGE_KEY,
        JSON.stringify(persisted),
      );
    } catch (error) {
      console.warn('[SUBSCRIPTION] Failed to persist subscription state', error);
    }
    this.state = nextState;
    this.notify();
    return this.state;
  }

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function toSubscriptionState(
  persisted: PersistedSubscriptionState,
): SubscriptionState {
  const expired =
    persisted.expiresAt != null &&
    Date.parse(persisted.expiresAt) <= Date.now();
  const tier = expired ? 'free' : persisted.tier;
  return {
    tier,
    expiresAt: expired ? null : persisted.expiresAt,
    isPro: tier === 'pro',
  };
}

export const subscriptionRepository = new SubscriptionRepository();
