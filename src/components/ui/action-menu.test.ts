import { menuPosition } from './action-menu';

jest.mock('expo-router', () => ({ useIsFocused: () => true, useFocusEffect: jest.fn() }));
jest.mock('@/components/ui/app-icon', () => ({ AppIcon: () => null }));
jest.mock('@/components/ui/glass-surface', () => ({ glassRim: () => ({}) }));

describe('anchored menu positioning', () => {
  const viewport = { width: 390, height: 844, top: 44, bottom: 34 };
  it('aligns to the tapped control while remaining in the safe viewport', () => {
    expect(menuPosition({ x: 334, y: 52, width: 40, height: 40 }, { width: 260, height: 160 }, viewport))
      .toEqual({ left: 114, top: 100 });
  });
  it('clamps long menus away from the bottom system area', () => {
    const position = menuPosition({ x: 320, y: 730, width: 40, height: 40 }, { width: 260, height: 300 }, viewport);
    expect(position.top).toBe(494);
    expect(position.left).toBeGreaterThanOrEqual(16);
  });
  it('keeps left-edge triggers on screen', () => {
    expect(menuPosition({ x: 10, y: 44, width: 40, height: 40 }, { width: 260, height: 160 }, viewport).left).toBe(16);
  });
});
