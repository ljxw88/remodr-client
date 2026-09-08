import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import Svg, { Path } from 'react-native-svg';

import { AgentProviderIcon, providerBrandColor } from './agent-provider-icon';

describe('agent-provider-icon', () => {
  it('returns distinct brand colors for each provider', () => {
    expect(providerBrandColor('copilot')).toBe('#8957E5');
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
});
