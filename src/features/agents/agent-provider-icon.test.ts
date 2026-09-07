import { Buffer } from 'node:buffer';
import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import Svg, { Path } from 'react-native-svg';
import sharp from 'sharp';

import { AgentProviderIcon, providerBrandColor } from './agent-provider-icon';

describe('agent-provider-icon', () => {
  it('returns distinct brand colors for each provider', () => {
    expect(providerBrandColor('copilot')).toBe('#8957E5');
    expect(providerBrandColor('claude')).toBe('#D97757');
    expect(providerBrandColor('codex')).toBe('#10A37F');
    expect(providerBrandColor('opencode')).toBe('#737373');
    expect(providerBrandColor('unknown')).toBe('#94A3B8');
  });

  it('renders the geometric OpenCode glyph at the requested size and tint', () => {
    let renderer: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(AgentProviderIcon, {
        provider: 'opencode', size: 28, tintColor: '#737373',
      }));
    });
    const svg = renderer!.root.findByType(Svg);
    const path = renderer!.root.findByType(Path);
    expect(svg.props).toMatchObject({ width: 28, height: 28, viewBox: '0 0 24 24' });
    expect(path.props).toMatchObject({
      fill: '#737373', fillRule: 'evenodd',
      d: 'M3 4h18v16H3V4Zm2 2v12h14V6H5Zm2 3h2v6H7V9Zm4 4h6v2h-6v-2Z',
    });
    TestRenderer.act(() => renderer!.unmount());
  });

  it('centers the complete Claude glyph without clipping its rays', async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(AgentProviderIcon, {
        provider: 'claude', size: 22, tintColor: '#676FFF',
      }));
    });
    const svg = renderer!.root.findByType(Svg);
    const path = renderer!.root.findByType(Path);
    expect(svg.props.width).toBe(22);
    expect(svg.props.height).toBe(22);
    expect(path.props.fill).toBe('#676FFF');
    const source = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="${svg.props.viewBox}"><path d="${path.props.d}" fill="white"/></svg>`;
    TestRenderer.act(() => renderer!.unmount());

    const { data, info } = await sharp(Buffer.from(source)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    let left = info.width, top = info.height, right = -1, bottom = -1;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        if (!data[(y * info.width + x) * 4 + 3]) continue;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    expect(right).toBeGreaterThan(left);
    const rightMargin = info.width - 1 - right;
    const bottomMargin = info.height - 1 - bottom;
    expect(Math.min(left, top, rightMargin, bottomMargin)).toBeGreaterThan(8);
    expect(Math.abs(left - rightMargin)).toBeLessThanOrEqual(2);
    expect(Math.abs(top - bottomMargin)).toBeLessThanOrEqual(2);
  });
});
