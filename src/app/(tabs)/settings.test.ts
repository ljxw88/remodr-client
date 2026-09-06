import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { Linking, Pressable, Switch } from 'react-native';
import { router } from 'expo-router';

import SettingsScreen from './settings';
import { settingsRepository } from '@/services/settings-repository';

jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
}));

jest.mock('expo-constants', () => ({
  expoConfig: {
    name: 'Remodr',
    version: '0.1.0',
    android: { versionCode: 1 },
    ios: { buildNumber: '1' },
  },
}));

jest.mock('@/components/ui/app-icon', () => ({
  AppIcon: () => null,
}));

jest.mock('@/features/navigation/floating-dock', () => ({
  useDockContentInset: () => 80,
  useDockScrollHandler: () => jest.fn(),
}));

describe('SettingsScreen', () => {
  let renderer: TestRenderer.ReactTestRenderer;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Linking, 'openURL').mockResolvedValue(true as any);
  });

  afterEach(() => {
    TestRenderer.act(() => {
      renderer?.unmount();
    });
    jest.restoreAllMocks();
  });

  it('renders app title, alpha badge, and version numbers', () => {
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(SettingsScreen));
    });

    const root = renderer.root;
    const textNodes = root.findAllByType('Text' as any);
    const allText = textNodes.map((n) => n.props.children).flat().join(' ');

    expect(allText).toContain('Remodr');
    expect(allText).toContain('ALPHA');
    expect(allText).toContain('v0.1.0');
    expect(allText).toContain('Build');
    expect(allText).toContain('v0.1.0 (1)');
  });

  it('toggles marquee animation and workspace filters preferences', async () => {
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(SettingsScreen));
    });

    const setMarqueeSpy = jest.spyOn(settingsRepository, 'setMarqueeEnabled');
    const setFiltersSpy = jest.spyOn(settingsRepository, 'setAgentFiltersExpanded');

    const switches = renderer.root.findAllByType(Switch);
    expect(switches.length).toBe(2);

    // Toggle Marquee
    await TestRenderer.act(async () => {
      switches[0].props.onValueChange(false);
    });
    expect(setMarqueeSpy).toHaveBeenCalledWith(false);

    // Toggle Workspace filters
    await TestRenderer.act(async () => {
      switches[1].props.onValueChange(false);
    });
    expect(setFiltersSpy).toHaveBeenCalledWith(false);
  });

  it('navigates to diagnostics screen when pressed', () => {
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(SettingsScreen));
    });

    const diagnosticsButton = renderer.root.findByProps({
      accessibilityLabel: 'Runtime diagnostics',
    });

    TestRenderer.act(() => {
      diagnosticsButton.props.onPress();
    });

    expect(router.push).toHaveBeenCalledWith('/diagnostics');
  });

  it('opens GitHub releases when pressed', () => {
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(SettingsScreen));
    });

    const releasesButton = renderer.root.findByProps({
      accessibilityLabel: 'GitHub releases, View updates',
    });

    TestRenderer.act(() => {
      releasesButton.props.onPress();
    });

    expect(Linking.openURL).toHaveBeenCalledWith('https://github.com/ljxw88/remodr-client/releases');
  });
});
