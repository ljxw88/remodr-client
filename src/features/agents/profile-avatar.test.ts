import { Colors, ControlHeight } from '@/constants/theme';
import {
  PROFILE_AVATAR_SIZE,
  ProfileAvatar,
  getConnectionStatusColor,
} from './profile-avatar';

// The rim draws through Skia, which Jest is not set up to transform. This
// suite never renders, so the drawing is out of scope either way. `jest.mock`
// is hoisted above the imports regardless of where it is written.
jest.mock('@/components/ui/liquid-glass-rim', () => ({ LiquidGlassRim: () => null }));

describe('ProfileAvatar', () => {
  it('is defined and exports ProfileAvatar', () => {
    expect(ProfileAvatar).toBeDefined();
    expect(typeof ProfileAvatar).toBe('function');
  });

  it('is drawn at the height of the button it shares a line with', () => {
    expect(PROFILE_AVATAR_SIZE).toBe(ControlHeight.header);
  });

  it('is made of the same glass as the controls it sits beside', () => {
    expect(Colors.glass).toBe(Colors.backgroundElement);
    expect(Colors.glass).toMatch(/^rgba\(255,255,255/);
  });

  describe('getConnectionStatusColor', () => {
    it('returns success color for connected status', () => {
      expect(getConnectionStatusColor('connected')).toBe(Colors.success);
    });

    it('returns accent color for connecting / transitional statuses', () => {
      expect(getConnectionStatusColor('connecting')).toBe(Colors.accent);
      expect(getConnectionStatusColor('authenticating')).toBe(Colors.accent);
      expect(getConnectionStatusColor('starting_bridge')).toBe(Colors.accent);
      expect(getConnectionStatusColor('synchronizing')).toBe(Colors.accent);
      expect(getConnectionStatusColor('reconnecting')).toBe(Colors.accent);
    });

    it('returns danger color for error status', () => {
      expect(getConnectionStatusColor('error')).toBe(Colors.danger);
    });

    it('returns warning color for disconnected status', () => {
      expect(getConnectionStatusColor('disconnected')).toBe(Colors.warning);
    });

    it('returns glass border for undefined status', () => {
      expect(getConnectionStatusColor(undefined)).toBe(Colors.glassBorder);
    });
  });
});
