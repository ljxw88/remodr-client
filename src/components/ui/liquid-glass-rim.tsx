import {
  Canvas,
  LinearGradient,
  RoundedRect,
  SweepGradient,
} from '@shopify/react-native-skia';
import { useCallback, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Colors, withAlpha } from '@/constants/theme';

const RIM_COLOURS = [
  'rgba(255,255,255,0.42)',
  'rgba(150,170,255,0.55)',
  'rgba(150,255,240,0.45)',
  'rgba(255,255,255,0.60)',
  'rgba(255,220,170,0.45)',
  'rgba(255,255,255,0.42)',
] as const;

/**
 * The New agent button's iridescent rim, on its own.
 *
 * A stripped-down sibling of `LiquidGlassButton`: the frosted body and the
 * static sweep-gradient stroke, without the refraction, the backdrop glow,
 * or the chromatic orb. Those are what make that button expensive, and they
 * are what make it the one hero control — a selected chip should quote the
 * material, not compete with it.
 *
 * Selected filters settle into this appearance instead of continuously asking
 * for attention with a rotating highlight.
 *
 * Fills its parent, so the parent must carry the radius and no padding —
 * Yoga insets absolute children by the parent's padding, which would pull the
 * rim inside the control instead of tracing its edge.
 */
export function LiquidGlassRim() {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) =>
      current && current.width === width && current.height === height
        ? current
        : { width, height },
    );
  }, []);

  return (
    // Measured on a plain View: Skia's Canvas ignores `onLayout` under Fabric.
    <View style={StyleSheet.absoluteFill} onLayout={onLayout} pointerEvents="none">
      {size ? (
        <Canvas style={StyleSheet.absoluteFill} colorSpace="srgb">
          {/* Frosted body, so the pill reads as glass rather than a flat tint. */}
          <RoundedRect
            x={0}
            y={0}
            width={size.width}
            height={size.height}
            r={size.height / 2}>
            <LinearGradient
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: size.height }}
              colors={[
                'rgba(255,255,255,0.20)',
                withAlpha(Colors.accent, 0.10),
                'rgba(255,255,255,0.16)',
              ]}
            />
          </RoundedRect>

          <RoundedRect
            x={0.75}
            y={0.75}
            width={size.width - 1.5}
            height={size.height - 1.5}
            r={(size.height - 1.5) / 2}
            style="stroke"
            strokeWidth={1.5}>
            <SweepGradient
              c={{ x: size.width / 2, y: size.height / 2 }}
              origin={{ x: size.width / 2, y: size.height / 2 }}
              colors={[...RIM_COLOURS]}
            />
          </RoundedRect>
        </Canvas>
      ) : null}
    </View>
  );
}
