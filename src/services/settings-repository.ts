import AsyncStorage from '@react-native-async-storage/async-storage';

export const SETTINGS_STORAGE_KEY = 'remote-workspace.settings.v1';

export type AppSettings = {
  marqueeEnabled: boolean;
};

export const DEFAULT_SETTINGS: AppSettings = {
  marqueeEnabled: true,
};

type Listener = () => void;
type KeyValueStorage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export class SettingsRepository {
  private settings: AppSettings = { ...DEFAULT_SETTINGS };
  private listeners = new Set<Listener>();
  private loaded = false;
  private initPromise: Promise<AppSettings> | null = null;

  constructor(private readonly storage: KeyValueStorage = AsyncStorage) {}

  init(): Promise<AppSettings> {
    if (this.loaded) {
      return Promise.resolve(this.settings);
    }
    this.initPromise ??= this.load();
    return this.initPromise;
  }

  private async load(): Promise<AppSettings> {
    try {
      const raw = await this.storage.getItem(SETTINGS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed.marqueeEnabled === 'boolean') {
          this.settings = {
            ...this.settings,
            marqueeEnabled: parsed.marqueeEnabled,
          };
        }
      }
    } catch (error) {
      console.warn('[SETTINGS] Failed to load settings', error);
    } finally {
      this.loaded = true;
      this.notify();
    }
    return this.settings;
  }

  getSnapshot = (): AppSettings => {
    return this.settings;
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

  async setMarqueeEnabled(enabled: boolean): Promise<AppSettings> {
    this.settings = {
      ...this.settings,
      marqueeEnabled: enabled,
    };
    try {
      await this.storage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify(this.settings),
      );
    } catch (error) {
      console.warn('[SETTINGS] Failed to persist settings', error);
    }
    this.notify();
    return this.settings;
  }

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const settingsRepository = new SettingsRepository();
