import { BlurView } from 'expo-blur';
import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from 'expo-glass-effect';
import { Platform, StyleSheet, View, type ViewProps, type ViewStyle } from 'react-native';

import { CanvasFill } from '@/components/ui/app-background';
import { useBlurBackdrop } from '@/components/ui/blur-backdrop';
import { Colors, GlassMaterial, Radius } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type Props = ViewProps & {
  /**
   * `panel` sits directly on the canvas — chips, header buttons, cards. There
   * is only the gradient behind it, so it is a translucent fill and a rim; a
   * blur pass there would cost a frame to draw the same picture.
   *
   * `chrome` floats over scrolling content — the dock, the composer. The blur
   * is doing real work there, so it samples the shared backdrop.
   */
  tone?: 'panel' | 'chrome';
  strength?: 'regular' | 'strong';
  /** Specular top edge. Off for surfaces that already draw their own. */
  highlight?: boolean;
  /** Overrides the rim, e.g. an accent outline on a selected chip. */
  rimColor?: string;
};

/**
 * The border that makes a translucent fill read as glass: a hairline rim with
 * a brighter top edge, standing in for light catching the upper curve.
 *
 * Deliberately a real border rather than an absolutely positioned overlay.
 * Yoga lays absolute children out against the parent's *padding* box, not its
 * border box, so an overlay rim inside a padded surface traces the content
 * instead of the edge — a visible box floating inside the glass. A border is
 * drawn on the border box and cannot drift.
 *
 * Spread into any `Pressable` or animated view that needs the material without
 * an extra layout node.
 */
export function glassRim(color?: string, highlight = true): ViewStyle {
  return {
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: color ?? Colors.glassBorder,
    borderTopColor: highlight ? Colors.glassHighlight : (color ?? Colors.glassBorder),
  };
}

/**
 * The one frosted surface in the app. Everything that should read as glass
 * goes through here so the material stays consistent; see `COLOR.md` for how
 * to tune it.
 */
export function GlassSurface({
  children,
  style,
  tone = 'panel',
  strength = 'regular',
  highlight = true,
  rimColor,
  ...props
}: Props) {
  const theme = useTheme();
  const blurTarget = useBlurBackdrop();
  const strong = strength === 'strong';
  const rim = glassRim(rimColor, highlight);

  const canUseLiquidGlass =
    Platform.OS === 'ios' && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();

  if (canUseLiquidGlass) {
    return (
      <GlassView
        {...props}
        glassEffectStyle="regular"
        colorScheme="dark"
        tintColor={strong ? theme.glassStrong : theme.glass}
        style={[styles.surface, rim, style]}>
        {children}
      </GlassView>
    );
  }

  if (tone === 'chrome' && blurTarget) {
    const { chrome } = GlassMaterial;
    return (
      <BlurView
        {...props}
        blurTarget={blurTarget}
        blurMethod="dimezisBlurViewSdk31Plus"
        intensity={strong ? chrome.intensityStrong : chrome.intensity}
        blurReductionFactor={
          strong ? chrome.blurReductionFactorStrong : chrome.blurReductionFactor
        }
        tint={strong ? chrome.tintStrong : chrome.tint}
        style={[
          styles.surface,
          rim,
          { backgroundColor: strong ? chrome.fillStrong : chrome.fill },
          style,
        ]}>
        {children}
      </BlurView>
    );
  }

  if (tone === 'chrome') {
    /**
     * Chrome with no backdrop in scope.
     *
     * `chrome` floats over scrolling content, and the blur is what hides that
     * content — a 23px radius turns rows into a smear, and the dark tint sinks
     * what is left. Falling back to the panel material loses all of it: the
     * fill is 7% white, so the transcript scrolls under the composer and stays
     * perfectly readable through it.
     *
     * So the surface brings the canvas with it. The gradient is opaque and
     * `CanvasFill` lines it up with the window, so the surface reads exactly as
     * it does at rest — it is the same picture already behind it — but nothing
     * can come through from underneath any more. Where the blur showed a moving
     * smear this shows still canvas, which at the foot of the gradient is very
     * nearly the same thing.
     *
     * Both layers are absolute, and Yoga lays absolute children out against the
     * padding box, so a chrome surface has to keep `padding: 0` and pad an
     * inner view instead. Both of ours already do, for the same reason the rim
     * is a real border rather than an overlay.
     */
    return (
      <View {...props} style={[styles.surface, rim, style]}>
        <CanvasFill />
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: strong ? theme.glassStrong : theme.glass },
          ]}
        />
        {children}
      </View>
    );
  }

  return (
    <View
      {...props}
      style={[
        styles.surface,
        rim,
        { backgroundColor: strong ? theme.glassStrong : theme.glass },
        style,
      ]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * No elevation and no drop shadow, deliberately.
   *
   * Android draws a view's shadow behind the view. An opaque fill hid it; a
   * translucent one does not, so the shadow shows straight through the glass
   * as a dark band inside its own edges. Glass separates from the canvas by
   * its rim and its fill, which is how the material is meant to read anyway.
   */
  surface: {
    borderRadius: Radius.glass,
    overflow: 'hidden',
  },
});
