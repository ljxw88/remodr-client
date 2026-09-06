import { SETTINGS_STORAGE_KEY, SettingsRepository } from './settings-repository';

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

  it('shows the agent filters until told otherwise, and remembers being told', async () => {
    const settings = await repository.init();
    expect(settings.agentFiltersExpanded).toBe(true);

    await repository.setAgentFiltersExpanded(false);
    expect(repository.getSnapshot().agentFiltersExpanded).toBe(false);
    expect(JSON.parse(mockStore[SETTINGS_STORAGE_KEY]).agentFiltersExpanded).toBe(false);

    // And it did not take the other settings down with it.
    expect(repository.getSnapshot().marqueeEnabled).toBe(true);
  });

  it('keeps defaults for keys a stored settings file predates', async () => {
    mockStore[SETTINGS_STORAGE_KEY] = JSON.stringify({ marqueeEnabled: false });

    await repository.init();

    expect(repository.getSnapshot().marqueeEnabled).toBe(false);
    expect(repository.getSnapshot().agentFiltersExpanded).toBe(true);
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
    mockStore[SETTINGS_STORAGE_KEY] = JSON.stringify({
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
