import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useRef, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { BackgroundGradient } from '@/constants/theme';

type Props = {
  /**
   * How far below the window top this copy of the canvas is mounted.
   *
   * The gradient is always drawn at full window height and shifted up by this
   * much, so a copy rendered part-way down the screen continues the canvas
   * rather than restarting it. Without it, a gradient mounted below a
   * navigation header jumps back to its brightest colour at the header's lower
   * edge and leaves a visible band.
   */
  topOffset?: number;
};

/**
 * The app canvas.
 *
 * Drawn per screen rather than once behind the navigator. A screen that does
 * not paint its own canvas is transparent, and two transparent screens in a
 * transition are both legible at once — the outgoing one hangs over the
 * incoming one as a double exposure until the animation ends. Each copy is
 * identical and offset to line up with the last, so the canvas still reads as
 * one continuous surface the routes move across.
 */
export function AppBackground({ topOffset = 0 }: Props) {
  const { height } = useWindowDimensions();

  return (
    <LinearGradient
      colors={[...BackgroundGradient.colors]}
      locations={[...BackgroundGradient.locations]}
      style={
        topOffset > 0
          ? { position: 'absolute', left: 0, right: 0, top: -topOffset, height }
          : StyleSheet.absoluteFill
      }
      pointerEvents="none"
    />
  );
}

/**
 * A copy of the canvas that finds its own place in the window.
 *
 * Drop it in as the first child of anything that has to be opaque. It measures
 * where it landed and shifts its gradient up by that much, so a subtree
 * mounted below a header continues the canvas instead of restarting it at its
 * brightest colour.
 */
export function CanvasFill() {
  const probe = useRef<View | null>(null);
  const [topOffset, setTopOffset] = useState(0);

  const onProbeLayout = useCallback(() => {
    probe.current?.measureInWindow((_x, y) => {
      setTopOffset((current) => (Math.abs(current - y) < 1 ? current : y));
    });
  }, []);

  return (
    <>
      {/*
        Measured from a plain child rather than from the parent. Giving a
        `BlurTargetView` an `onLayout` stops its descendants receiving layout
        events at all, which silently starves anything that sizes itself that
        way — a Skia canvas measured that way simply renders nothing — and its
        ref is a native instance with no `measureInWindow`.
      */}
      <View
        ref={probe}
        onLayout={onProbeLayout}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      />
      <AppBackground topOffset={topOffset} />
    </>
  );
}
