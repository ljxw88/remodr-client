import {
  Canvas,
  LinearGradient,
  RoundedRect,
  SweepGradient,
} from '@shopify/react-native-skia';
import { useCallback, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useDerivedValue } from 'react-native-reanimated';

import { useShaderClock } from '@/hooks/use-shader-clock';
import { Colors, withAlpha } from '@/constants/theme';

/** Matches the New agent button, so a selection reads as the same material. */
const RIM_PERIOD_MS = 6000;

const RIM_COLOURS = [
  'rgba(255,255,255,0.42)',
  'rgba(150,170,255,0.55)',
  'rgba(150,255,240,0.45)',
  'rgba(255,255,255,0.60)',
  'rgba(255,220,170,0.45)',
  'rgba(255,255,255,0.42)',
] as const;

type Props = {
  /** Pauses the clock when the control is not selected. */
  active?: boolean;
};

/**
 * The New agent button's iridescent rim, on its own.
 *
 * A stripped-down sibling of `LiquidGlassButton`: the frosted body and the
 * rotating sweep-gradient stroke, without the refraction, the backdrop glow,
 * or the chromatic orb. Those are what make that button expensive, and they
 * are what make it the one hero control — a selected chip should quote the
 * material, not compete with it.
 *
 * Cheap enough to use on a selection because only one chip per row can be
 * selected, and the clock stops as soon as it is not.
 *
 * Fills its parent, so the parent must carry the radius and no padding —
 * Yoga insets absolute children by the parent's padding, which would pull the
 * rim inside the control instead of tracing its edge.
 */
export function LiquidGlassRim({ active = true }: Props) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const clock = useShaderClock(active);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) =>
      current && current.width === width && current.height === height
        ? current
        : { width, height },
    );
  }, []);

  const rimTransform = useDerivedValue(
    () => [{ rotate: (clock.value / RIM_PERIOD_MS) % (Math.PI * 2) }],
    [clock],
  );

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

          {/* Rotating iridescent rim. Rotation is on the gradient, not on a
              Group: rotating the geometry spins the pill itself. */}
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
              transform={rimTransform}
              colors={[...RIM_COLOURS]}
            />
          </RoundedRect>
        </Canvas>
      ) : null}
    </View>
  );
}
