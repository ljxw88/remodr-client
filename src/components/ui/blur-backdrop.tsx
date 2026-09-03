import { BlurTargetView } from 'expo-blur';
import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { AppBackground } from '@/components/ui/app-background';

type BlurTarget = RefObject<View | null>;

const BlurBackdropContext = createContext<BlurTarget | null>(null);

/**
 * Shares one blur target between a screen's content and the frosted chrome
 * floating above it.
 *
 * Wrap the screen in the provider, put the scrolling content inside
 * `BlurBackdropTarget`, and render the chrome as a *sibling* of that target.
 *
 * The sibling rule is not stylistic. A `BlurView` draws its target's
 * RenderNode, so nesting one inside its own target makes that RenderNode
 * contain itself. Android then recurses through `RenderNode::prepareTreeImpl`
 * until the native stack overflows and the process dies with SIGSEGV — no JS
 * error, no red box, just a vanished app.
 */
export function BlurBackdropProvider({ children }: { children: ReactNode }) {
  const target = useRef<View | null>(null);

  return (
    <BlurBackdropContext.Provider value={target}>
      {children}
    </BlurBackdropContext.Provider>
  );
}

/**
 * The content frosted chrome is allowed to sample.
 *
 * It carries its own copy of the canvas gradient because the blur can only see
 * this subtree: with the gradient left outside, chrome blurs transparent
 * pixels and reads as a dead grey slab. Drawing the gradient twice costs one
 * more fully-covered `LinearGradient`, which is cheaper than the alternatives.
 */
export function BlurBackdropTarget({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const target = useContext(BlurBackdropContext);
  const probe = useRef<View | null>(null);
  const [topOffset, setTopOffset] = useState(0);

  // Where this backdrop sits in the window, so its copy of the canvas can be
  // shifted up to continue the one behind the navigator instead of restarting.
  const onProbeLayout = useCallback(() => {
    probe.current?.measureInWindow((_x, y) => {
      setTopOffset((current) => (Math.abs(current - y) < 1 ? current : y));
    });
  }, []);

  return (
    <BlurTargetView ref={target ?? undefined} style={[styles.fill, style]}>
      {/*
        Measured from a child, for two reasons. Giving the BlurTargetView an
        `onLayout` prop stops its descendants receiving layout events at all,
        which silently starves anything that sizes itself that way — a Skia
        canvas measured that way simply renders nothing. And its ref is a
        native component instance that has no `measureInWindow`.
      */}
      <View
        ref={probe}
        onLayout={onProbeLayout}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      />
      <AppBackground topOffset={topOffset} />
      {children}
    </BlurTargetView>
  );
}

/**
 * The backdrop frosted chrome should blur, or `undefined` when there is none
 * in scope — React Native modals render in their own window and cannot reach
 * one, so they fall back to an opaque surface.
 */
export function useBlurBackdrop(): BlurTarget | undefined {
  return useContext(BlurBackdropContext) ?? undefined;
}

const styles = StyleSheet.create({
  fill: {
    flex: 1,
  },
});
