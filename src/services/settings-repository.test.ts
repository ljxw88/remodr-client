import { SettingsRepository } from './settings-repository';

describe('SettingsRepository', () => {
  let mockStore: Record<string, string>;
  let repository: SettingsRepository;
  let getItem: jest.Mock<Promise<string | null>, [string]>;

  beforeEach(() => {
    mockStore = {};
    getItem = jest.fn(async (key: string) => mockStore[key] ?? null);
    const mockStorage = {
      getItem,
      setItem: jest.fn(async (key: string, value: string) => {
        mockStore[key] = value;
      }),
    };
    repository = new SettingsRepository(mockStorage);
  });

  it('initializes with default marqueeEnabled: true', async () => {
    const settings = await repository.init();
    expect(settings.marqueeEnabled).toBe(true);
    expect(repository.getSnapshot().marqueeEnabled).toBe(true);
  });

  it('updates and persists marqueeEnabled', async () => {
    await repository.setMarqueeEnabled(false);
    expect(repository.getSnapshot().marqueeEnabled).toBe(false);

    await repository.setMarqueeEnabled(true);
    expect(repository.getSnapshot().marqueeEnabled).toBe(true);
  });

  it('notifies subscribers on change', async () => {
    const listener = jest.fn();
    const unsubscribe = repository.subscribe(listener);

    await repository.setMarqueeEnabled(false);
    expect(listener).toHaveBeenCalled();

    unsubscribe();
  });

  it('replaces the snapshot object when stored settings load', async () => {
    mockStore['remote-workspace.settings.v1'] = JSON.stringify({
      marqueeEnabled: false,
    });
    const initialSnapshot = repository.getSnapshot();

    await repository.init();

    expect(repository.getSnapshot()).not.toBe(initialSnapshot);
    expect(repository.getSnapshot().marqueeEnabled).toBe(false);
  });

  it('shares one storage read between concurrent initialization calls', async () => {
    await Promise.all([repository.init(), repository.init()]);

    expect(getItem).toHaveBeenCalledTimes(1);
  });
});
