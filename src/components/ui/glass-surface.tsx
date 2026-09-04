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
     * There is no blur to fall back *to*, either. `expo-blur` needs a
     * `BlurTargetView` on Android — without one every method degrades to a
     * plain translucent view — and a target may only live on a screen that is
     * never dismissed, which rules out every pushed route. See
     * `blur-backdrop.tsx`.
     *
     * So the surface stands in for it with its own copy of the canvas, lit from
     * the top edge. The canvas covers what the blur used to hide; the sheen
     * does what the blur used to do to the surface itself, which is give it a
     * shape that is its own rather than the shape of whatever it covers.
     *
     * Opaque, and not for want of trying. Transparency is the obvious way to
     * suggest glass and it cannot be made to work here: with nothing to smear
     * what comes through, the pass-through needed before the surface looks like
     * glass is also enough to leave the text behind it readable. See
     * `GlassMaterial.chrome.sheen`.
     *
     * Every layer here is absolute, and Yoga lays absolute children out against
     * the padding box, so a chrome surface has to keep `padding: 0` and pad an
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
            {
              experimental_backgroundImage: strong
                ? GlassMaterial.chrome.sheenStrong
                : GlassMaterial.chrome.sheen,
            },
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
