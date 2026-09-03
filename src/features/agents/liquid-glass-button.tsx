import {
  BlurMask,
  Canvas,
  Circle,
  Fill,
  Group,
  RadialGradient,
  RoundedRect,
  SweepGradient,
} from '@shopify/react-native-skia';
import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useDerivedValue } from 'react-native-reanimated';

import { ChromaticMetal } from '@/components/ui/chromatic-metal';
import { LiquidGlass } from '@/components/ui/liquid-glass';
import { ThemedText } from '@/components/themed-text';
import { AppIcon } from '@/components/ui/app-icon';
import { Colors, Radius, Spacing } from '@/constants/theme';
import { useShaderClock } from '@/hooks/use-shader-clock';

const HEIGHT = 48;
const ORB = 34;
const STROKE = 1.5;
const INSET = (HEIGHT - ORB) / 2;

type Props = {
  label: string;
  disabled?: boolean;
  onPress: () => void;
};

/**
 * Layer order matters. Skia's backdrop filter reads what this canvas has
 * already drawn, so anything the glass should bend must come first. The glow
 * exists to give the glass something to refract: on a near-black canvas a
 * displacement filter over flat colour is invisible.
 */
export function LiquidGlassButton({ label, disabled = false, onPress }: Props) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const clock = useShaderClock(!disabled);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) =>
      current && current.width === width && current.height === height
        ? current
        : { width, height },
    );
  }, []);

  const strokeTransform = useDerivedValue(
    () => [{ rotate: (clock.value / 5200) % (Math.PI * 2) }],
    [clock],
  );

  const orbCenter = INSET + ORB / 2;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      onLayout={onLayout}
      style={({ pressed }) => [
        styles.button,
        { opacity: disabled ? 0.45 : pressed ? 0.88 : 1 },
      ]}>
      {size ? (
        <Canvas style={StyleSheet.absoluteFill} opaque colorSpace="srgb">
          <Fill color={Colors.background} />

          {/* Backdrop the glass refracts. */}
          <Group>
            <Circle cx={orbCenter} cy={size.height / 2} r={size.height * 0.95}>
              <RadialGradient
                c={{ x: orbCenter, y: size.height / 2 }}
                r={size.height * 0.95}
                colors={['rgba(108,124,255,0.70)', 'rgba(108,124,255,0.16)', 'rgba(8,9,11,0)']}
              />
            </Circle>
            <Circle
              cx={size.width - size.height * 0.4}
              cy={size.height / 2}
              r={size.height * 0.7}>
              <RadialGradient
                c={{ x: size.width - size.height * 0.4, y: size.height / 2 }}
                r={size.height * 0.7}
                colors={['rgba(255,255,255,0.20)', 'rgba(255,255,255,0)']}
              />
            </Circle>
          </Group>

          <LiquidGlass
            x={0}
            y={0}
            width={size.width}
            height={size.height}
            radius={size.height / 2}
          />

          {/* Crisp orb, above the glass so the chrome stays sharp. */}
          <ChromaticMetal x={INSET} y={INSET} size={ORB} clock={clock} />
          <Circle cx={orbCenter} cy={orbCenter} r={ORB / 2} style="stroke" strokeWidth={1.5}>
            <SweepGradient
              c={{ x: orbCenter, y: orbCenter }}
              colors={['#FFFFFF', '#B9C2FF', '#FFFFFF', '#8E97B5', '#FFFFFF']}
            />
          </Circle>

          {/* Rim light. The pill is static; only the gradient rotates, so the
              colour travels along the border instead of spinning the shape. */}
          <RoundedRect
            x={STROKE / 2}
            y={STROKE / 2}
            width={size.width - STROKE}
            height={size.height - STROKE}
            r={(size.height - STROKE) / 2}
            style="stroke"
            strokeWidth={STROKE}>
            <SweepGradient
              c={{ x: size.width / 2, y: size.height / 2 }}
              origin={{ x: size.width / 2, y: size.height / 2 }}
              transform={strokeTransform}
              colors={[
                'rgba(255,255,255,0.55)',
                'rgba(108,124,255,1)',
                'rgba(120,230,255,0.9)',
                'rgba(255,255,255,0.75)',
                'rgba(255,198,92,0.85)',
                'rgba(255,255,255,0.55)',
              ]}
            />
            <BlurMask blur={0.6} style="solid" />
          </RoundedRect>
        </Canvas>
      ) : null}

      <View style={styles.content} pointerEvents="none">
        <View style={styles.orb}>
          <AppIcon
            name={{ ios: 'plus', android: 'add', web: 'add' }}
            size={17}
            tintColor={Colors.text}
            fallback="+"
          />
        </View>
        <ThemedText type="smallBold">{label}</ThemedText>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: HEIGHT,
    borderRadius: Radius.pill,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingLeft: INSET,
    paddingRight: Spacing.two + Spacing.half,
  },
  orb: {
    width: ORB,
    height: ORB,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
