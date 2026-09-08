import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { StyleSheet } from 'react-native';

import { HostRow, HostRowSkeleton } from '@/features/hosts/HostRow';
import { SelectionRow, SelectionRowSkeleton } from './form-page';
import { SkeletonGroup, SkeletonLine } from './skeleton';

jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/components/ui/marquee-text', () => ({ MarqueeText: () => null }));
jest.mock('@/features/connection/use-host-session', () => ({ useHostSession: () => null }));
jest.mock('@/hooks/use-theme', () => ({
  useTheme: () => jest.requireActual<typeof import('@/constants/theme')>('@/constants/theme').Colors,
}));

describe('loading row geometry', () => {
  let renderer: TestRenderer.ReactTestRenderer | undefined;
  afterEach(() => { TestRenderer.act(() => renderer?.unmount()); renderer = undefined; });
  function realRowStyle() {
    const row = renderer!.root.findAll((node) =>
      typeof node.props.style === 'function' && typeof node.props.onPress === 'function', { deep: false })[0];
    return StyleSheet.flatten(row.props.style({ pressed: false }));
  }

  it('keeps server card dimensions and caption line boxes identical', () => {
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(HostRow, {
        host: { id: 'host', name: 'Host', hostname: 'host.local', username: 'user', port: 22 },
        onPress: () => {},
      }));
    });
    const style = realRowStyle();
    TestRenderer.act(() => renderer!.update(createElement(HostRowSkeleton)));
    const skeleton = StyleSheet.flatten(renderer!.root.findByType(SkeletonGroup).props.style);
    for (const key of ['minHeight', 'gap', 'paddingHorizontal', 'borderRadius', 'borderWidth']) {
      expect(skeleton[key]).toBe(style[key]);
    }
    expect(renderer!.root.findAllByType(SkeletonLine).map((line) => line.props.lineHeight ?? 18)).toEqual([18, 18]);
  });

  it('uses the selection row padding and the actual 20/18 description line boxes', () => {
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(SelectionRow, { label: 'Folder', description: 'Folder', onPress: () => {} }));
    });
    const style = realRowStyle();
    TestRenderer.act(() => renderer!.update(createElement(SelectionRowSkeleton)));
    expect(StyleSheet.flatten(renderer!.root.findByType(SkeletonGroup).props.style)).toEqual(
      expect.objectContaining({
        minHeight: style.minHeight, paddingVertical: style.paddingVertical,
        paddingHorizontal: style.paddingHorizontal, gap: style.gap, borderBottomWidth: style.borderBottomWidth,
      }),
    );
    expect(renderer!.root.findAllByType(SkeletonLine).map((line) => line.props.lineHeight)).toEqual([20, 18]);
  });

});
