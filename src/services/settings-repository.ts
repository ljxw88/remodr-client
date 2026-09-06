import AsyncStorage from '@react-native-async-storage/async-storage';

export const SETTINGS_STORAGE_KEY = 'remote-workspace.settings.v1';

export type AppSettings = {
  marqueeEnabled: boolean;
  /** Whether the agents screen shows its device and space filters. */
  agentFiltersExpanded: boolean;
};

export const DEFAULT_SETTINGS: AppSettings = {
  marqueeEnabled: true,
  agentFiltersExpanded: true,
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
        // Field by field, so a settings file written before a key existed
        // keeps its defaults rather than reading `undefined` over them.
        const stored: Partial<AppSettings> = {};
        if (typeof parsed.marqueeEnabled === 'boolean') {
          stored.marqueeEnabled = parsed.marqueeEnabled;
        }
        if (typeof parsed.agentFiltersExpanded === 'boolean') {
          stored.agentFiltersExpanded = parsed.agentFiltersExpanded;
        }
        this.settings = { ...this.settings, ...stored };
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

  setMarqueeEnabled(enabled: boolean): Promise<AppSettings> {
    return this.update({ marqueeEnabled: enabled });
  }

  setAgentFiltersExpanded(expanded: boolean): Promise<AppSettings> {
    return this.update({ agentFiltersExpanded: expanded });
  }

  private async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = { ...this.settings, ...patch };
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
