import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { StyleSheet, View } from 'react-native';

import { SkeletonBlock, SkeletonGroup, SkeletonLine } from './skeleton';

let mockFontScale = 1;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 390, height: 844, scale: 1, fontScale: mockFontScale }),
}));
jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => jest.requireActual<typeof import('@/constants/theme')>('@/constants/theme').Colors,
}));

describe('skeleton primitives', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  afterEach(() => { TestRenderer.act(() => renderer?.unmount()); renderer = undefined; mockFontScale = 1; });

  it('exposes one non-interactive loading group instead of fake buttons or content', () => {
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(SkeletonGroup, { label: 'Loading rows' },
        createElement(SkeletonBlock, { width: 44, height: 44, radius: 14 })));
    });
    const root = renderer!.root.findByType(View);
    expect(root.props).toMatchObject({
      accessible: true, accessibilityRole: 'progressbar', accessibilityLabel: 'Loading rows',
      accessibilityState: { busy: true }, pointerEvents: 'none',
    });
    const block = renderer!.root.findByType(SkeletonBlock).findByType(View);
    expect(StyleSheet.flatten(block.props.style)).toMatchObject({ width: 44, height: 44, borderRadius: 14 });
    expect(block.props.accessible).toBe(false);
  });

  it('matches the real line box at increased font sizes', () => {
    mockFontScale = 1.5;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(SkeletonLine, { width: '72%', lineHeight: 20 }));
    });
    expect(StyleSheet.flatten(renderer!.root.findByType(View).props.style).height).toBe(30);
    expect(renderer!.root.findByType(SkeletonBlock).props).toMatchObject({ width: '72%', height: 16.5 });
  });
});
