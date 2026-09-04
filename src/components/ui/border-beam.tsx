import {
  Canvas,
  RoundedRect,
  SweepGradient,
} from '@shopify/react-native-skia';
import { useCallback, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useDerivedValue } from 'react-native-reanimated';

import { useShaderClock } from '@/hooks/use-shader-clock';

const BEAM_PERIOD_MS = 3200;

/**
 * Animated border beam riding the perimeter of the card, using the app's
 * violet accent (#6C7CFF), emerald cyan (#5BE49B), and white specular highlight.
 */
const BEAM_COLORS = [
  'rgba(108, 124, 255, 0)',
  'rgba(108, 124, 255, 0.15)',
  'rgba(108, 124, 255, 0.75)',
  'rgba(91, 228, 155, 0.90)',
  '#FFFFFF',
  'rgba(108, 124, 255, 0.70)',
  'rgba(108, 124, 255, 0.15)',
  'rgba(108, 124, 255, 0)',
  'rgba(108, 124, 255, 0)',
] as const;

const BEAM_POSITIONS = [0, 0.03, 0.08, 0.13, 0.16, 0.20, 0.25, 0.30, 1.0];

type Props = {
  radius?: number;
  active?: boolean;
  borderWidth?: number;
  periodMs?: number;
};

export function BorderBeam({
  radius,
  active = true,
  borderWidth = 1.5,
  periodMs = BEAM_PERIOD_MS,
}: Props) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const clock = useShaderClock(active);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) {
      setSize((current) =>
        current && Math.abs(current.width - width) < 0.5 && Math.abs(current.height - height) < 0.5
          ? current
          : { width, height },
      );
    }
  }, []);

  const beamTransform = useDerivedValue(
    () => [{ rotate: (clock.value / periodMs) % (Math.PI * 2) }],
    [clock, periodMs],
  );

  const effectiveRadius = size
    ? (radius ?? Math.min(size.width, size.height) / 2)
    : (radius ?? 18);

  const halfStroke = borderWidth / 2;

  return (
    <View style={StyleSheet.absoluteFill} onLayout={onLayout} pointerEvents="none">
      {size ? (
        <Canvas style={StyleSheet.absoluteFill} colorSpace="srgb" pointerEvents="none">
          {/* Base glass perimeter rim */}
          <RoundedRect
            x={0.5}
            y={0.5}
            width={size.width - 1}
            height={size.height - 1}
            r={Math.max(0, effectiveRadius - 0.5)}
            style="stroke"
            strokeWidth={1}
            color="rgba(255, 255, 255, 0.12)"
          />

          {/* Ambient soft glow along the border */}
          <RoundedRect
            x={halfStroke}
            y={halfStroke}
            width={size.width - borderWidth}
            height={size.height - borderWidth}
            r={Math.max(0, effectiveRadius - halfStroke)}
            style="stroke"
            strokeWidth={borderWidth * 1.8}
            opacity={0.45}>
            <SweepGradient
              c={{ x: size.width / 2, y: size.height / 2 }}
              origin={{ x: size.width / 2, y: size.height / 2 }}
              transform={beamTransform}
              colors={[...BEAM_COLORS]}
              positions={BEAM_POSITIONS}
            />
          </RoundedRect>

          {/* Core sharp beam */}
          <RoundedRect
            x={halfStroke}
            y={halfStroke}
            width={size.width - borderWidth}
            height={size.height - borderWidth}
            r={Math.max(0, effectiveRadius - halfStroke)}
            style="stroke"
            strokeWidth={borderWidth}>
            <SweepGradient
              c={{ x: size.width / 2, y: size.height / 2 }}
              origin={{ x: size.width / 2, y: size.height / 2 }}
              transform={beamTransform}
              colors={[...BEAM_COLORS]}
              positions={BEAM_POSITIONS}
            />
          </RoundedRect>
        </Canvas>
      ) : null}
    </View>
  );
}
