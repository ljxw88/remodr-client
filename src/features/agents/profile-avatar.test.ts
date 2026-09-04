import { Colors } from '@/constants/theme';
import {
  DEFAULT_AVATAR_BACKGROUND,
  PROFILE_AVATAR_SIZE,
  ProfileAvatar,
  getConnectionStatusColor,
} from './profile-avatar';

describe('ProfileAvatar', () => {
  it('is defined and exports ProfileAvatar', () => {
    expect(ProfileAvatar).toBeDefined();
    expect(typeof ProfileAvatar).toBe('function');
  });

  it('matches New Agent button height (50px)', () => {
    expect(PROFILE_AVATAR_SIZE).toBe(50);
  });

  it('exports a tunable DEFAULT_AVATAR_BACKGROUND color string', () => {
    expect(typeof DEFAULT_AVATAR_BACKGROUND).toBe('string');
    expect(DEFAULT_AVATAR_BACKGROUND.length).toBeGreaterThan(0);
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
