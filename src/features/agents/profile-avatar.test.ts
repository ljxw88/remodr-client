import { Colors, ControlHeight } from '@/constants/theme';
import {
  PROFILE_AVATAR_SIZE,
  ProfileAvatar,
  getConnectionStatusColor,
} from './profile-avatar';

describe('ProfileAvatar', () => {
  it('is defined and exports ProfileAvatar', () => {
    expect(ProfileAvatar).toBeDefined();
    expect(typeof ProfileAvatar).toBe('function');
  });

  it('is drawn at the height of the button it shares a line with', () => {
    expect(PROFILE_AVATAR_SIZE).toBe(ControlHeight.header);
  });

  it('has a fill in the theme rather than one of its own', () => {
    expect(typeof Colors.avatarFill).toBe('string');
    expect(Colors.avatarFill.length).toBeGreaterThan(0);
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
