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
    <BlurTargetView ref={target ?? undefined} style={[styles.fill, style]}>
      <CanvasFill />
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
