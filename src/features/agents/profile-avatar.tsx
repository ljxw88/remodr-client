import { router } from 'expo-router';
import { useCallback } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { AppIcon, type AppIconName } from '@/components/ui/app-icon';
import { glassRim } from '@/components/ui/glass-surface';
import { LiquidGlassRim } from '@/components/ui/liquid-glass-rim';
import { Colors, ControlHeight } from '@/constants/theme';
import type { HerdrConnectionState } from '@/domain/herdr';
import { useTheme } from '@/hooks/use-theme';

/** Drawn at the height of the New Agent button it shares a line with. */
export const PROFILE_AVATAR_SIZE = ControlHeight.header;
const SIZE = PROFILE_AVATAR_SIZE;

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
  /** Fill override, for a control that has a state of its own to show. */
  backgroundColor?: string;
  /** Icon/text tint color override (defaults to theme.text) */
  tintColor?: string;
  /** Optional image URL for user profile picture */
  imageUri?: string;
  /** Optional initials to display inside the avatar */
  initials?: string;
  /** Custom icon override (defaults to person.fill / person) */
  icon?: AppIconName;
  /** Glyph to draw where the platform has no symbol for `icon`. */
  fallback?: string;
  /**
   * Marks the button as a disclosure control and says which way it points, for
   * screen readers. Left off when the button is not one.
   */
  expanded?: boolean;
  /**
   * Wears the New agent button's material instead of the flat glass plate: a
   * frosted body and a slowly turning iridescent rim, drawn in Skia.
   *
   * For the round button sharing the header's top line with it, so the two read
   * as one pair rather than two unrelated controls. It is drawn over the glass
   * plate rather than instead of it, which is what a selected chip does with
   * the same rim; the status colour steps aside, since an iridescent edge and
   * a semantic one cannot both have the border.
   */
  liquidRim?: boolean;
  /** Disables the button */
  disabled?: boolean;
  /** Optional container style */
  style?: StyleProp<ViewStyle>;
};

/**
 * The header's round button, drawn at the New agent button's height so the two
 * read as a pair.
 *
 * The same glass as every other control that sits on the canvas: a translucent
 * white plate and a hairline rim with a brighter top edge. It used to be the
 * one header control that darkened the canvas instead of lightening it, which
 * bought its status ring contrast at the price of being the only thing on that
 * line made of something else.
 *
 * The rim carries the connection status, so it is the app's rim in weight and
 * the status palette in colour. That leaves the fill free for whatever state
 * the button itself has, which is why it is the caller's to pass.
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
  fallback = '👤',
  expanded,
  liquidRim = false,
  disabled = false,
  style,
}: ProfileAvatarProps) {
  const theme = useTheme();
  const effectiveBorderColor = statusColor ?? getConnectionStatusColor(status, theme);
  const effectiveBackgroundColor = backgroundColor ?? theme.glass;
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
      accessibilityState={{ disabled, expanded }}
      disabled={disabled}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.container,
        /*
          The plate and its rim stay under the drawn one, which is also what a
          selected chip does. Taking them away to let the drawn rim be the whole
          edge looks right in principle and does not survive contact: with no
          fill and no border the button stops painting on Android altogether,
          chevron included. Only the colour steps aside — an iridescent edge and
          a status one cannot both have the border.
        */
        glassRim(liquidRim ? undefined : effectiveBorderColor),
        {
          backgroundColor: effectiveBackgroundColor,
          // Dims and shrinks, at the depth the button beside it dims to.
          opacity: disabled ? 0.45 : pressed ? 0.72 : 1,
          transform: [{ scale: pressed && !disabled ? 0.96 : 1 }],
        },
        style,
      ]}>
      {liquidRim ? <LiquidGlassRim active={!disabled} /> : null}
      {/*
        A layer of its own, so it can be lifted above the rim. Being declared
        after the canvas is not enough on Android — the canvas composited its
        frosted body over the icon and left it looking washed rather than
        drawn. The selected chip keeps its label in a wrapper for its own
        reasons and gets the same protection by accident.
      */}
      <View style={styles.content}>
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
            fallback={fallback}
          />
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
    flexShrink: 0,
  },
  content: {
    // Above the drawn rim, and the reason this is a view at all.
    zIndex: 1,
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarImage: {
    width: '100%',
    height: '100%',
  },
});

