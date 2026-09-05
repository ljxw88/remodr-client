import { createElement, useState, type ReactNode } from 'react';
import TestRenderer from 'react-test-renderer';
import { Text } from 'react-native';

import { RouteStack } from './route-stack';

const mockEntrance = { play: jest.fn(), reset: jest.fn(), style: {} };
let mockFocused = true;
let mockState = { index: 0, routes: [{ key: 'settings' }] };
type AppearanceListener = (event: { data: { closing: boolean } }) => void;
const mockListeners = new Map<string, AppearanceListener>();
const mockNavigations = new Map<string, {
  addListener: (event: string, listener: AppearanceListener) => () => void;
  isFocused: () => boolean;
}>();

function mockNavigationFor(key: string) {
  let navigation = mockNavigations.get(key);
  if (!navigation) {
    navigation = {
      addListener: (_event, listener) => {
        mockListeners.set(key, listener);
        return () => { if (mockListeners.get(key) === listener) mockListeners.delete(key); };
      },
      isFocused: () => mockFocused && mockState.routes[mockState.index].key === key,
    };
    mockNavigations.set(key, navigation);
  }
  return navigation;
}

jest.mock('expo-router', () => ({
  useIsFocused: () => mockFocused,
  Stack: ({ layout, children }: {
    layout: (props: {
      state: typeof mockState;
      descriptors: Record<string, { navigation: ReturnType<typeof mockNavigationFor> }>;
      children: ReactNode;
    }) => ReactNode;
    children: ReactNode;
  }) => layout({
    state: mockState,
    descriptors: Object.fromEntries(mockState.routes.map(({ key }) => [key, { navigation: mockNavigationFor(key) }])),
    children,
  }),
}));
jest.mock('@/components/ui/app-background', () => ({ AppBackground: () => null }));
jest.mock('@/components/ui/blur-backdrop', () => ({
  BlurBackdropProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('./screen-entrance', () => ({ useScreenEntrance: () => mockEntrance }));
jest.mock('./stack-screen-options', () => ({ useStackScreenOptions: () => ({ animation: 'none' }) }));

describe('stack page arrivals', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  let mounts: number;

  function Draft() {
    const [value] = useState(() => { mounts++; return 'Unsaved name'; });
    return createElement(Text, null, value);
  }
  function render() {
    const page = createElement(RouteStack, { quiet: true }, createElement(Draft));
    TestRenderer.act(() => {
      if (renderer) renderer.update(page);
      else renderer = TestRenderer.create(page);
    });
  }
  function appear(key = mockState.routes[mockState.index].key, closing = false) {
    TestRenderer.act(() => mockListeners.get(key)?.({ data: { closing } }));
  }
  beforeEach(() => {
    jest.clearAllMocks();
    mockFocused = true;
    mockState = { index: 0, routes: [{ key: 'settings' }] };
    mockListeners.clear();
    mockNavigations.clear();
    mounts = 0;
  });
  afterEach(() => {
    TestRenderer.act(() => renderer?.unmount());
    renderer = undefined;
  });

  it('animates opening, nested pushes, replacements, and Back without remounting content', () => {
    render();
    expect(mockEntrance.play).not.toHaveBeenCalled();
    appear();
    expect(mockEntrance.play).toHaveBeenLastCalledWith(1);
    mockState = { index: 1, routes: [{ key: 'settings' }, { key: 'models' }] };
    render();
    expect(mockEntrance.play).toHaveBeenCalledTimes(1);
    appear();
    expect(mockEntrance.play).toHaveBeenLastCalledWith(1);
    mockState = { index: 1, routes: [{ key: 'settings' }, { key: 'replacement' }] };
    render();
    appear();
    expect(mockEntrance.play).toHaveBeenLastCalledWith(1);
    mockState = { index: 0, routes: [{ key: 'settings' }] };
    render();
    appear();
    expect(mockEntrance.play.mock.calls).toEqual([[1], [1], [1], [-1]]);
    expect(mounts).toBe(1);
    expect(renderer?.root.findByType(Text).props.children).toBe('Unsaved name');
  });

  it('does not replay for a new snapshot of the same route or ordinary form updates', () => {
    render();
    appear();
    mockState = { index: 0, routes: [{ key: 'settings' }] };
    render();
    appear();
    expect(mockEntrance.play).toHaveBeenCalledTimes(1);
  });

  it('stops while covered and animates Back when the same page becomes visible again', () => {
    render();
    appear();
    mockEntrance.reset.mockClear();
    mockFocused = false;
    render();
    expect(mockEntrance.reset).toHaveBeenCalledTimes(1);
    expect(mockEntrance.play).toHaveBeenCalledTimes(1);
    mockFocused = true;
    render();
    expect(mockEntrance.play).toHaveBeenCalledTimes(1);
    appear();
    expect(mockEntrance.play.mock.calls).toEqual([[1], [-1]]);
  });

  it('does not animate hidden route changes and treats a newly opened route as forward', () => {
    render();
    appear();
    mockFocused = false;
    render();
    mockState = { index: 1, routes: [{ key: 'settings' }, { key: 'models' }] };
    render();
    expect(mockEntrance.play).toHaveBeenCalledTimes(1);
    mockFocused = true;
    render();
    appear();
    expect(mockEntrance.play.mock.calls).toEqual([[1], [1]]);
  });

  it('waits for focus when a navigator is initially mounted in the background', () => {
    mockFocused = false;
    render();
    expect(mockEntrance.play).not.toHaveBeenCalled();
    mockFocused = true;
    render();
    appear();
    expect(mockEntrance.play).toHaveBeenCalledWith(1);
  });

  it('ignores disappearing screens and late appearances from superseded navigation', () => {
    render();
    const staleAppearance = mockListeners.get('settings');
    appear('settings', true);
    expect(mockEntrance.play).not.toHaveBeenCalled();
    mockState = { index: 1, routes: [{ key: 'settings' }, { key: 'models' }] };
    render();
    appear('settings');
    TestRenderer.act(() => staleAppearance?.({ data: { closing: false } }));
    expect(mockEntrance.play).not.toHaveBeenCalled();
    appear('models');
    appear('models');
    expect(mockEntrance.play).toHaveBeenCalledTimes(1);
    mockFocused = false;
    render();
    appear('models');
    expect(mockEntrance.play).toHaveBeenCalledTimes(1);
  });
});
