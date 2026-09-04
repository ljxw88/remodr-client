import { router } from 'expo-router';
import { useCallback } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { AppIcon, type AppIconName } from '@/components/ui/app-icon';
import { Colors } from '@/constants/theme';
import type { HerdrConnectionState } from '@/domain/herdr';
import { useTheme } from '@/hooks/use-theme';

export const PROFILE_AVATAR_SIZE = 50;
const SIZE = PROFILE_AVATAR_SIZE;

/**
 * Default background color for the profile avatar.
 * Tune this color directly (e.g. '#1E2338', '#141829', 'rgba(255,255,255,0.08)', etc.).
 */
export const DEFAULT_AVATAR_BACKGROUND = 'rgba(26, 25, 62, 0.3)';

export function getConnectionStatusColor(
  status: HerdrConnectionState | undefined,
  colors: typeof Colors = Colors,
): string {
  if (status === 'connected') {
    return colors.success;
  }
  if (
    status &&
    ['connecting', 'authenticating', 'starting_bridge', 'synchronizing', 'reconnecting'].includes(
      status,
    )
  ) {
    return colors.accent;
  }
  if (status === 'error') {
    return colors.danger;
  }
  if (status === 'disconnected') {
    return colors.warning;
  }
  return colors.glassBorder;
}

export type ProfileAvatarProps = {
  /** Optional click handler; defaults to opening settings */
  onPress?: () => void;
  /** Accessibility label */
  accessibilityLabel?: string;
  /** Herdr connection status */
  status?: HerdrConnectionState;
  /** Explicit border color override for connection status */
  statusColor?: string;
  /** Background pure color override (defaults to adapting to the interface: theme.backgroundElement) */
  backgroundColor?: string;
  /** Icon/text tint color override (defaults to theme.text) */
  tintColor?: string;
  /** Optional image URL for user profile picture */
  imageUri?: string;
  /** Optional initials to display inside the avatar */
  initials?: string;
  /** Custom icon override (defaults to person.fill / person) */
  icon?: AppIconName;
  /** Disables the button */
  disabled?: boolean;
  /** Optional container style */
  style?: StyleProp<ViewStyle>;
};

/**
 * Circular profile avatar with pure background color adapting to the interface
 * material and a border displaying the active connection status. Matches the
 * New agent button's 50px height.
 */
export function ProfileAvatar({
  onPress,
  accessibilityLabel = 'Profile settings',
  status,
  statusColor,
  backgroundColor,
  tintColor,
  imageUri,
  initials,
  icon = { ios: 'person.fill', android: 'person', web: 'person' },
  disabled = false,
  style,
}: ProfileAvatarProps) {
  const theme = useTheme();
  const effectiveBorderColor = statusColor ?? getConnectionStatusColor(status, theme);
  const effectiveBackgroundColor = backgroundColor ?? DEFAULT_AVATAR_BACKGROUND;
  const effectiveTintColor = tintColor ?? theme.text;

  const handlePress = useCallback(() => {
    if (onPress) {
      onPress();
    } else {
      router.push('/(tabs)/settings');
    }
  }, [onPress]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.container,
        {
          backgroundColor:
            pressed && !disabled ? theme.backgroundSelected : effectiveBackgroundColor,
          borderColor: effectiveBorderColor,
          opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
          transform: [{ scale: pressed && !disabled ? 0.96 : 1 }],
        },
        style,
      ]}>
      {imageUri ? (
        <Image
          source={{ uri: imageUri }}
          style={styles.avatarImage}
          resizeMode="cover"
        />
      ) : initials ? (
        <ThemedText type="smallBold" style={{ color: effectiveTintColor }}>
          {initials}
        </ThemedText>
      ) : (
        <AppIcon
          name={icon}
          size={20}
          tintColor={effectiveTintColor}
          fallback="👤"
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    borderWidth: 2,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
    flexShrink: 0,
  },
  avatarImage: {
    width: '100%',
    height: '100%',
  },
});

