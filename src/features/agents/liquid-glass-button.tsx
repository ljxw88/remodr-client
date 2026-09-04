import {
  Canvas,
  Circle,
  Group,
  LinearGradient,
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
import { Colors, ControlHeight, Radius, Spacing } from '@/constants/theme';
import { useShaderClock } from '@/hooks/use-shader-clock';

const HEIGHT = ControlHeight.header;
const INSET = 5;
const ORB = HEIGHT - INSET * 2;
const BEZEL = 2.5;

type Props = {
  /** Label for the agent button (defaults to "New agent") */
  agentLabel?: string;
  /** Whether an agent can be created */
  canCreateAgent?: boolean;
  /** Callback when tapping New agent */
  onPressAgent?: () => void;
  /** Label for the space button (e.g. "New space") */
  spaceLabel?: string;
  /** Whether a space can be created */
  canCreateSpace?: boolean;
  /** Callback when tapping New space */
  onPressSpace?: () => void;

  /** Legacy / single-button fallback props */
  label?: string;
  disabled?: boolean;
  onPress?: () => void;
};

/**
 * Layer order matters. Skia's backdrop filter reads what this canvas has
 * already drawn, so anything the glass should bend must come first. The glow
 * exists to give the glass something to refract: on a near-black canvas a
 * displacement filter over flat colour is invisible.
 *
 * Supports single button or merged split button (New agent + New space).
 */
export function LiquidGlassButton({
  agentLabel,
  canCreateAgent,
  onPressAgent,
  spaceLabel,
  canCreateSpace,
  onPressSpace,
  label,
  disabled = false,
  onPress,
}: Props) {
  const isSplit = Boolean(spaceLabel && onPressSpace);
  const effectiveAgentLabel = agentLabel ?? label ?? 'New Agent';
  const effectiveCanCreateAgent = canCreateAgent ?? !disabled;
  const effectiveOnPressAgent = onPressAgent ?? onPress ?? (() => {});

  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const clockActive = isSplit
    ? effectiveCanCreateAgent || Boolean(canCreateSpace)
    : !disabled;
  const clock = useShaderClock(clockActive);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize((current) =>
      current && current.width === width && current.height === height
        ? current
        : { width, height },
    );
  }, []);

  const rimTransform = useDerivedValue(
    () => [{ rotate: (clock.value / 6000) % (Math.PI * 2) }],
    [clock],
  );
  const bezelTransform = useDerivedValue(
    () => [{ rotate: (-clock.value / 9000) % (Math.PI * 2) }],
    [clock],
  );

  const orbCentre = INSET + ORB / 2;

  return (
    <View
      onLayout={onLayout}
      style={styles.button}>
      {size ? (
        <Canvas style={StyleSheet.absoluteFill} colorSpace="srgb" pointerEvents="none">
          {/* Backdrop the glass refracts. Kept vertically centred so the
              refraction has similar content to bend on every edge. */}
          <Group>
            <Circle cx={orbCentre} cy={size.height / 2} r={size.height}>
              <RadialGradient
                c={{ x: orbCentre, y: size.height / 2 }}
                r={size.height}
                colors={['rgba(108,124,255,0.55)', 'rgba(108,124,255,0.12)', 'rgba(108,124,255,0)']}
              />
            </Circle>
            <Circle
              cx={size.width - size.height * 0.35}
              cy={size.height / 2}
              r={size.height * 0.85}>
              <RadialGradient
                c={{ x: size.width - size.height * 0.35, y: size.height / 2 }}
                r={size.height * 0.85}
                colors={['rgba(255,255,255,0.16)', 'rgba(255,255,255,0)']}
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

          {/* Frosted body, so the pill reads as glass rather than a dark hole. */}
          <RoundedRect
            x={0}
            y={0}
            width={size.width}
            height={size.height}
            r={size.height / 2}>
            <LinearGradient
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: size.height }}
              colors={['rgba(255,255,255,0.18)', 'rgba(255,255,255,0.05)', 'rgba(255,255,255,0.18)']}
            />
          </RoundedRect>

          {/* Iridescent rim. Kept low in alpha so it reads as a fringe on the
              glass edge rather than a coloured outline. */}
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
              colors={[
                'rgba(255,255,255,0.42)',
                'rgba(150,170,255,0.55)',
                'rgba(150,255,240,0.45)',
                'rgba(255,255,255,0.60)',
                'rgba(255,220,170,0.45)',
                'rgba(255,255,255,0.42)',
              ]}
            />
          </RoundedRect>

          {/* Polished bezel, then the orb inside it. */}
          <Circle cx={orbCentre} cy={orbCentre} r={ORB / 2}>
            <SweepGradient
              c={{ x: orbCentre, y: orbCentre }}
              origin={{ x: orbCentre, y: orbCentre }}
              transform={bezelTransform}
              colors={['#FFFFFF', '#9AA4BE', '#FFFFFF', '#6E778F', '#EDF1FF', '#FFFFFF']}
            />
          </Circle>
          <ChromaticMetal
            x={INSET + BEZEL}
            y={INSET + BEZEL}
            size={ORB - BEZEL * 2}
            clock={clock}
          />
        </Canvas>
      ) : null}

      {isSplit ? (
        <View style={styles.content}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={effectiveAgentLabel}
            accessibilityState={{ disabled: !effectiveCanCreateAgent }}
            disabled={!effectiveCanCreateAgent}
            onPress={effectiveOnPressAgent}
            style={({ pressed }) => [
              styles.agentSegment,
              {
                opacity: !effectiveCanCreateAgent ? 0.45 : pressed ? 0.72 : 1,
                backgroundColor: pressed ? 'rgba(255,255,255,0.08)' : 'transparent',
              },
            ]}>
            <View style={styles.orb}>
              <AppIcon
                name={{ ios: 'plus', android: 'add', web: 'add' }}
                size={18}
                tintColor={Colors.text}
                fallback="+"
              />
            </View>
            <ThemedText type="smallBold" style={{ color: Colors.text }}>
              {effectiveAgentLabel}
            </ThemedText>
          </Pressable>

          <View style={styles.divider} />

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={spaceLabel}
            accessibilityState={{ disabled: !canCreateSpace }}
            disabled={!canCreateSpace}
            onPress={onPressSpace}
            style={({ pressed }) => [
              styles.spaceSegment,
              {
                opacity: !canCreateSpace ? 0.42 : pressed ? 0.72 : 1,
                backgroundColor: pressed ? 'rgba(255,255,255,0.08)' : 'transparent',
              },
            ]}>
            <ThemedText type="smallBold" style={{ color: Colors.text }}>
              {spaceLabel}
            </ThemedText>
          </Pressable>
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={effectiveAgentLabel}
          accessibilityState={{ disabled: !effectiveCanCreateAgent }}
          disabled={!effectiveCanCreateAgent}
          onPress={effectiveOnPressAgent}
          style={({ pressed }) => [
            styles.singleContent,
            { opacity: !effectiveCanCreateAgent ? 0.45 : pressed ? 0.9 : 1 },
          ]}>
          <View style={styles.orb}>
            <AppIcon
              name={{ ios: 'plus', android: 'add', web: 'add' }}
              size={18}
              tintColor={Colors.text}
              fallback="+"
            />
          </View>
          <ThemedText type="smallBold">{effectiveAgentLabel}</ThemedText>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    height: HEIGHT,
    borderRadius: Radius.pill,
    overflow: 'hidden',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  content: {
    flexDirection: 'row',
    alignItems: 'stretch',
    height: HEIGHT,
  },
  singleContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + Spacing.half,
    paddingLeft: INSET,
    paddingRight: Spacing.three,
    height: HEIGHT,
  },
  agentSegment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingLeft: INSET,
    paddingRight: Spacing.one + Spacing.half,
    borderTopLeftRadius: Radius.pill,
    borderBottomLeftRadius: Radius.pill,
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    height: 22,
    alignSelf: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.20)',
  },
  spaceSegment: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: Spacing.one + Spacing.half,
    paddingRight: Spacing.two + Spacing.half,
    borderTopRightRadius: Radius.pill,
    borderBottomRightRadius: Radius.pill,
  },
  orb: {
    width: ORB,
    height: ORB,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
