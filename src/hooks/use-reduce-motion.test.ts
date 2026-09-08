describe('shared reduced-motion preference', () => {
  let resolve: (value: boolean) => void;
  let reject: (error: Error) => void;
  let changed: (enabled: boolean) => void;
  let store: typeof import('./use-reduce-motion');
  let warning: jest.SpyInstance;

  beforeEach(() => {
    const pending = new Promise<boolean>((yes, no) => { resolve = yes; reject = no; });
    jest.doMock('react-native', () => ({
      AccessibilityInfo: {
        isReduceMotionEnabled: () => pending,
        addEventListener: (_event: string, listener: (enabled: boolean) => void) => { changed = listener; },
      },
    }));
    warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.isolateModules(() => { store = jest.requireActual<typeof import('./use-reduce-motion')>('./use-reduce-motion'); });
  });
  afterEach(() => { jest.dontMock('react-native'); warning.mockRestore(); });

  it('defaults to static UI until the asynchronous preference is known', async () => {
    expect(store.getReducedMotion()).toBe(true);
    resolve(false);
    await Promise.resolve();
    expect(store.getReducedMotion()).toBe(false);
  });

  it('does not let a late startup read overwrite a newer system preference', async () => {
    const listener = jest.fn();
    const unsubscribe = store.subscribeReduceMotion(listener);
    changed(true);
    resolve(false);
    await Promise.resolve();
    expect(store.getReducedMotion()).toBe(true);
    expect(listener.mock.calls).toEqual([[true]]);
    unsubscribe();
    changed(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getReducedMotion()).toBe(false);
  });

  it('reports an unavailable setting and keeps motion disabled rather than guessing', async () => {
    reject(new Error('Preference unavailable'));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getReducedMotion()).toBe(true);
    expect(warning).toHaveBeenCalledWith('[MOTION] Could not read reduced-motion preference', expect.any(Error));
  });
});
