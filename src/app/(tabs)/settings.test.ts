import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';
import { Switch } from 'react-native';
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
  });

  afterEach(() => {
    TestRenderer.act(() => {
      renderer?.unmount();
    });
    jest.restoreAllMocks();
  });

  it('renders version and credentials cleanly', () => {
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(SettingsScreen));
    });

    const root = renderer.root;
    const textNodes = root.findAllByType('Text' as any);
    const allText = textNodes.map((n) => n.props.children).flat().join(' ');

    expect(allText).toContain('Credentials');
    expect(allText).toContain('Android Keystore');
    expect(allText).toContain('Host keys');
    expect(allText).toContain('Strict verification');
    expect(allText).toContain('Version');
    expect(allText).toContain('v0.1.0 (1)');
    expect(allText).toContain('Diagnostics');
  });

  it('toggles marquee animation setting', async () => {
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(SettingsScreen));
    });

    const setMarqueeSpy = jest.spyOn(settingsRepository, 'setMarqueeEnabled');
    const switchComp = renderer.root.findByType(Switch);

    await TestRenderer.act(async () => {
      switchComp.props.onValueChange(false);
    });
    expect(setMarqueeSpy).toHaveBeenCalledWith(false);
  });

  it('navigates to diagnostics screen when pressed', () => {
    TestRenderer.act(() => {
      renderer = TestRenderer.create(createElement(SettingsScreen));
    });

    const diagnosticsRow = renderer.root.findByProps({
      accessibilityLabel: 'Diagnostics, Open →',
    });

    TestRenderer.act(() => {
      diagnosticsRow.props.onPress();
    });

    expect(router.push).toHaveBeenCalledWith('/diagnostics');
  });
});
