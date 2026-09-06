import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';

import { AnimatedTabContent } from './floating-dock';

let mockPathname = '/';
let mockOnTransition: ((event: { data: { closing: boolean } }) => void) | undefined;
const mockEntrance = {
  arm: jest.fn(), settle: jest.fn(), play: jest.fn(), reset: jest.fn(), style: {},
};
const mockNavigation = {
  addListener: (_event: string, listener: NonNullable<typeof mockOnTransition>) => {
    mockOnTransition = listener;
    return () => { if (mockOnTransition === listener) mockOnTransition = undefined; };
  },
  isFocused: () => ['/', '/servers', '/settings'].includes(mockPathname),
};

jest.mock('expo-router', () => ({
  usePathname: () => mockPathname,
  useNavigation: () => mockNavigation,
}));
jest.mock('expo-router/ui', () => ({ TabTrigger: () => null }));
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/components/ui/glass-surface', () => ({ GlassSurface: () => null }));
jest.mock('./screen-entrance', () => ({ useScreenEntrance: () => mockEntrance }));

describe('dock page motion', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  function navigate(path: string) {
    mockPathname = path;
    TestRenderer.act(() => renderer.update(createElement(AnimatedTabContent)));
  }
  function appear(closing = false) {
    TestRenderer.act(() => mockOnTransition?.({ data: { closing } }));
  }
  beforeEach(() => {
    jest.clearAllMocks();
    mockPathname = '/';
    TestRenderer.act(() => { renderer = TestRenderer.create(createElement(AnimatedTabContent)); });
  });
  afterEach(() => TestRenderer.act(() => renderer.unmount()));

  it('animates tab changes in dock order but not initial mounting or unchanged routes', () => {
    expect(mockEntrance.play).not.toHaveBeenCalled();
    navigate('/servers');
    navigate('/servers');
    navigate('/');
    expect(mockEntrance.play.mock.calls).toEqual([[1], [-1]]);
  });

  it('offsets the dock the moment it is uncovered, and closes the gap on the native arrival', () => {
    navigate('/flows/models');
    expect(mockEntrance.reset).toHaveBeenCalled();
    appear();
    navigate('/');
    // Armed straight away: the page being dismissed is still covering it.
    expect(mockEntrance.arm.mock.calls).toEqual([[-1]]);
    expect(mockEntrance.settle).not.toHaveBeenCalled();
    appear(true);
    expect(mockEntrance.settle).not.toHaveBeenCalled();
    appear();
    appear();
    expect(mockEntrance.settle).toHaveBeenCalledTimes(1);
    expect(mockEntrance.play).not.toHaveBeenCalled();
  });

  it('cancels a pending return if another page covers the dock', () => {
    navigate('/agents/one');
    navigate('/');
    expect(mockEntrance.arm).toHaveBeenCalledWith(-1);
    navigate('/flows/rename-agent');
    // Covering it again puts the offset back, so nothing is left displaced.
    expect(mockEntrance.reset).toHaveBeenCalled();
    appear();
    expect(mockEntrance.settle).not.toHaveBeenCalled();
    navigate('/settings');
    appear();
    expect(mockEntrance.settle).toHaveBeenCalledTimes(1);
  });
});
