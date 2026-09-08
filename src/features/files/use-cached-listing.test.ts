import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';

import { useCachedListing } from './use-cached-listing';

type Options = Parameters<typeof useCachedListing>[0];
const files = [{ name: 'notes', path: '/project/notes', isDirectory: false, size: 12 }];

describe('scoped directory display retention', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let result: ReturnType<typeof useCachedListing>;
  let options: Options;
  function Harness(props: Options) { result = useCachedListing(props); return null; }
  function render(patch: Partial<Options> = {}) {
    options = { ...options, ...patch };
    TestRenderer.act(() => {
      const element = createElement(Harness, options);
      if (renderer) renderer.update(element);
      else renderer = TestRenderer.create(element);
    });
  }
  beforeEach(() => {
    options = { hostId: 'device-a', sessionId: 'session-a', path: '/project', ready: false, entries: [] };
  });
  afterEach(() => { TestRenderer.act(() => renderer?.unmount()); renderer = undefined; });

  it('replaces placeholders immediately and retains an empty result during refresh', () => {
    render();
    expect(result.available).toBe(false);
    render({ ready: true, entries: files });
    expect(result.entries).toBe(files);
    render({ ready: false, entries: [] });
    expect(result.entries).toBe(files);
    render({ ready: true, entries: [] });
    expect(result).toEqual({ available: true, entries: [] });
    render({ ready: false });
    expect(result).toEqual({ available: true, entries: [] });
  });

  it.each([
    { hostId: 'device-b' }, { sessionId: 'session-b' }, { path: '/other' }, { sessionId: null },
  ])('does not carry old entries across %j', (change) => {
    render({ ready: true, entries: files });
    render({ ...change, ready: false, entries: [] });
    expect(result).toEqual({ available: false, entries: [] });
    render({ hostId: 'device-a', sessionId: 'session-a', path: '/project' });
    expect(result).toEqual({ available: false, entries: [] });
  });
});
