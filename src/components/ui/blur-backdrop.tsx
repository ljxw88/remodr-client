import { BlurTargetView } from 'expo-blur';
import {
  createContext,
  useContext,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { CanvasFill } from '@/components/ui/app-background';

type BlurTarget = RefObject<View | null>;

const BlurBackdropContext = createContext<BlurTarget | null>(null);

/** Set by `BlurBackdropTarget`, so a nested one can decline to mount. */
const InsideBlurTargetContext = createContext(false);

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
 *
 * **Only put this on a screen whose arrival and departure are cuts.** A
 * `BlurTargetView` draws nothing at all from the moment its screen starts
 * animating away, so everything inside one blinks out while the screen is
 * still on top and still moving. Chrome outside the target keeps drawing,
 * which makes it look like the screen threw its content away rather than left.
 * This is not a property of any one animation — the platform default does it
 * too, it is just harder to see through a cross-fade — and it survives
 * `renderToHardwareTextureAndroid`.
 *
 * A pushed route used to be disqualified outright for that reason. It no
 * longer is, but only because pushes are cuts now. `animation: 'none'` alone
 * still left several frames of empty content and black chrome on Android.
 * `RouteStack` therefore hides its native root in layout-effect teardown,
 * before child blur targets are disposed. It restores the root on setup so
 * effect replay cannot leave a mounted stack invisible. This is a cut, not
 * an animated-dismissal solution; see `stack-screen-options.ts`.
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
 * It carries its own copy of the canvas because the blur can only see
 * this subtree: with the canvas left outside, chrome blurs transparent
 * pixels and reads as a dead grey slab.
 */
export function BlurBackdropTarget({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const target = useContext(BlurBackdropContext);

  return (
    <InsideBlurTargetContext.Provider value>
      <BlurTargetView ref={target ?? undefined} style={[styles.fill, style]}>
        <CanvasFill />
        {children}
      </BlurTargetView>
    </InsideBlurTargetContext.Provider>
  );
}

/**
 * Whether a blur target is already overhead.
 *
 * A target inside a target is the same shape as a `BlurView` inside one: both
 * put a RenderNode inside itself, and Android recurses until the stack
 * overflows. Anything that mounts a target opportunistically — rather than
 * because a screen deliberately placed it — has to ask this first.
 */
export function useInsideBlurTarget(): boolean {
  return useContext(InsideBlurTargetContext);
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
