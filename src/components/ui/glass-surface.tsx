import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import {
  GlassView,
  isGlassEffectAPIAvailable,
  isLiquidGlassAvailable,
} from 'expo-glass-effect';
import { Platform, StyleSheet, View, type ViewProps } from 'react-native';

import { useBlurBackdrop } from '@/components/ui/blur-backdrop';
import { GlassMaterial, Radius } from '@/constants/theme';
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
  /** Corner radius, so the rim overlay can match it. */
  radius?: number;
};

type RimProps = {
  radius?: number;
  /** Overrides the default hairline, e.g. an accent rim on a selected chip. */
  color?: string;
  highlight?: boolean;
};

/**
 * The border and specular top edge that make a translucent fill read as glass.
 *
 * Exported on its own so pressables and animated views can wear the material
 * without being wrapped in an extra layout node: drop it in as the last child
 * of any relatively-positioned container.
 *
 * Drawn as an overlay rather than a `borderWidth` so it never eats into the
 * container's padding, and so it sits above a `BlurView`'s tint instead of
 * being washed out beneath it.
 */
export function GlassRim({ radius = Radius.glass, color, highlight = true }: RimProps) {
  const theme = useTheme();
  return (
    <>
      <View
        pointerEvents="none"
        style={[
          styles.rim,
          { borderColor: color ?? theme.glassBorder, borderRadius: radius },
        ]}
      />
      {highlight ? (
        // Clipped to the corner radius so the specular bar stops where the
        // top edge starts to curve. Without the clip it runs straight past the
        // corners and floats over the canvas as a detached line.
        <View
          pointerEvents="none"
          style={[styles.highlightClip, { borderRadius: radius }]}>
          <LinearGradient
            colors={['transparent', theme.glassHighlight, 'transparent']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.highlight}
          />
        </View>
      ) : null}
    </>
  );
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
  radius = Radius.glass,
  ...props
}: Props) {
  const theme = useTheme();
  const blurTarget = useBlurBackdrop();
  const strong = strength === 'strong';

  const rim = <GlassRim radius={radius} highlight={highlight} />;

  const canUseLiquidGlass =
    Platform.OS === 'ios' && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();

  if (canUseLiquidGlass) {
    return (
      <GlassView
        {...props}
        glassEffectStyle="regular"
        colorScheme="dark"
        tintColor={strong ? theme.glassStrong : theme.glass}
        style={[styles.surface, { borderRadius: radius }, style]}>
        {children}
        {rim}
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
          styles.lifted,
          {
            backgroundColor: strong ? chrome.fillStrong : chrome.fill,
            borderRadius: radius,
            shadowColor: theme.glassShadow,
          },
          style,
        ]}>
        {children}
        {rim}
      </BlurView>
    );
  }

  return (
    <View
      {...props}
      style={[
        styles.surface,
        styles.lifted,
        {
          backgroundColor: strong ? theme.glassStrong : theme.glass,
          borderRadius: radius,
          shadowColor: theme.glassShadow,
        },
        style,
      ]}>
      {children}
      {rim}
    </View>
  );
}

const styles = StyleSheet.create({
  surface: {
    overflow: 'hidden',
  },
  lifted: {
    elevation: 3,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 1,
    shadowRadius: 18,
  },
  /**
   * An overlay rather than a `borderWidth` so the rim never eats into the
   * padding of whatever is passed in, and so it sits above a BlurView's tint
   * instead of being washed out under it.
   */
  rim: {
    ...StyleSheet.absoluteFill,
    borderWidth: StyleSheet.hairlineWidth * 2,
  },  highlightClip: {
    ...StyleSheet.absoluteFill,
    overflow: 'hidden',
  },
  /** Reads as light catching the top curve of the glass. */
  highlight: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth * 2,
  },
});
