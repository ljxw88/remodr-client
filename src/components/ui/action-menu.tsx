import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Animated, Keyboard, Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { AppIcon } from '@/components/ui/app-icon';
import { glassRim } from '@/components/ui/glass-surface';
import { Colors, ControlHeight, Radius, Spacing } from '@/constants/theme';
import { Motion } from '@/constants/motion';
import { useReduceMotion, useReducedMotion } from '@/hooks/use-reduce-motion';
import { useForeground } from '@/hooks/use-foreground';

/** Only the opaque menu surface moves; the native modal remains transparent. */
export const ENTRY_OFFSET = 4;

export type ActionMenuItem = {
  id: string;
  label: string;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
};

type Anchor = { x: number; y: number; width: number; height: number };

export function menuPosition(anchor: Anchor, menu: { width: number; height: number }, viewport: {
  width: number; height: number; top: number; bottom: number;
}) {
  const left = Math.max(Spacing.two, Math.min(anchor.x + anchor.width - menu.width, viewport.width - menu.width - Spacing.two));
  const below = anchor.y + anchor.height + Spacing.one;
  const bottom = viewport.height - viewport.bottom - Spacing.two;
  const top = Math.max(viewport.top + Spacing.one, Math.min(below, bottom - menu.height));
  return { left, top };
}

/** A small, anchored menu. The native modal supplies outside-touch/back handling;
 * its transparent backdrop does not dim or resize the conversation — only the
 * opaque menu surface itself fades and settles into place. */
export function ActionMenu({ label, items, disabled = false }: {
  label: string; items: ActionMenuItem[]; disabled?: boolean;
}) {
  const trigger = useRef<View | null>(null);
  const focused = useIsFocused();
  const foreground = useForeground();
  const eligible = focused && foreground && !disabled;
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const [anchor, setAnchor] = useState<(Anchor & { epoch: number }) | null>(null);
  // `present` keeps the modal mounted for an explicit close's exit fade;
  // `interactive` is the hit/accessibility gate and drops the instant any
  // dismissal starts, so a fading surface is never still tappable.
  const [present, setPresent] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const [height, setHeight] = useState(items.length * ControlHeight.row + Spacing.two);
  const [opacity] = useState(() => new Animated.Value(0));
  const [offset] = useState(() => new Animated.Value(ENTRY_OFFSET));
  const shouldReduceMotion = useReduceMotion();
  const reducedMotion = useReducedMotion();
  const selecting = useRef(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const eligibleRef = useRef(eligible);
  const interactiveRef = useRef(false);
  const shown = useRef(false);
  const startedEpoch = useRef<number | null>(null);
  const width = Math.min(240, dimensions.width - Spacing.four);

  // A preference flip mid-close must not strand a half-faded surface: finish
  // disappearing right away instead of hanging at a stale in-between value.
  // Settled here, alongside the render that carries the new preference,
  // rather than in an effect that would just spend an extra render calling
  // setState to do what this converges to immediately.
  if (present && (!eligible || (reducedMotion && !interactive))) {
    setPresent(false);
    setInteractive(false);
    setAnchor(null);
  }
  const open = present && eligible;

  /** Tears the menu down with no animation: blur, unmount, a choice being
   * made, or reduced motion all need the surface gone this instant rather
   * than lingering through a fade that would strand it over the next page. */
  const cancelLifetime = useCallback(() => {
    generation.current++;
    pending.current = false;
    interactiveRef.current = false;
    shown.current = false;
    opacity.stopAnimation();
    offset.stopAnimation();
  }, [opacity, offset]);

  const hideImmediately = useCallback(() => {
    cancelLifetime();
    opacity.setValue(0);
    offset.setValue(ENTRY_OFFSET);
    setInteractive(false);
    setPresent(false);
    setAnchor(null);
  }, [cancelLifetime, opacity, offset]);

  useLayoutEffect(() => {
    eligibleRef.current = eligible;
    return () => {
      eligibleRef.current = false;
      cancelLifetime();
    };
  }, [cancelLifetime, eligible]);

  const enter = useCallback((epoch: number) => {
    if (!shown.current || !eligibleRef.current || generation.current !== epoch ||
      !interactiveRef.current || startedEpoch.current === epoch) return;
    startedEpoch.current = epoch;
    opacity.stopAnimation();
    offset.stopAnimation();
    if (shouldReduceMotion() || reducedMotion) {
      opacity.setValue(1);
      offset.setValue(0);
      return;
    }
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1, duration: Motion.duration.reveal, easing: Motion.easing.entrance,
        useNativeDriver: true, isInteraction: false,
      }),
      Animated.timing(offset, {
        toValue: 0, duration: Motion.duration.reveal, easing: Motion.easing.entrance,
        useNativeDriver: true, isInteraction: false,
      }),
    ]).start();
  }, [offset, opacity, reducedMotion, shouldReduceMotion]);

  // Reversing an exit reuses an already-shown modal, so it has no second onShow event.
  useEffect(() => {
    if (interactive && anchor) enter(anchor.epoch);
  }, [anchor, enter, interactive]);

  // Purely imperative: an opening menu snaps its animated values to fully
  // shown, and a closing one (see above) to fully hidden, the instant
  // reduced motion is on — no setState here, only resetting the values a
  // suppressed animation would otherwise have been left holding mid-flight.
  useEffect(() => {
    if (!reducedMotion) return;
    opacity.stopAnimation();
    offset.stopAnimation();
    opacity.setValue(interactive ? 1 : 0);
    offset.setValue(interactive ? 0 : ENTRY_OFFSET);
  }, [reducedMotion, interactive, opacity, offset]);

  /** Explicit close: outside tap or the native Back gesture. Unlike a choice
   * being made, nothing here is racing to reveal another page underneath, so
   * the surface is allowed its short exit fade. */
  function dismiss() {
    if (!present || !interactiveRef.current) return;
    generation.current++;
    pending.current = false;
    interactiveRef.current = false;
    opacity.stopAnimation();
    offset.stopAnimation();
    setInteractive(false);
    if (shouldReduceMotion()) {
      hideImmediately();
      return;
    }
    const token = generation.current;
    Animated.timing(opacity, {
      toValue: 0,
      duration: Motion.duration.feedback,
      easing: Motion.easing.exit,
      useNativeDriver: true,
      isInteraction: false,
    }).start(({ finished }) => {
      // A rapid reopen bumps `generation` again; a stale completion here must
      // not dismiss the menu that has since reopened.
      if (finished && generation.current === token) {
        shown.current = false;
        setPresent(false);
        setAnchor(null);
      }
    });
  }

  function show() {
    if (!eligibleRef.current || pending.current) return;
    Keyboard.dismiss();
    pending.current = true;
    selecting.current = false;
    const token = ++generation.current;
    trigger.current?.measureInWindow((x, y, measuredWidth, measuredHeight) => {
      if (token !== generation.current || !eligibleRef.current) return;
      pending.current = false;
      if (!present) {
        shown.current = false;
        opacity.setValue(shouldReduceMotion() ? 1 : 0);
        offset.setValue(shouldReduceMotion() ? 0 : ENTRY_OFFSET);
      }
      setAnchor({ x, y, width: measuredWidth, height: measuredHeight, epoch: token });
      setPresent(true);
      setInteractive(true);
      interactiveRef.current = true;
      opacity.stopAnimation();
      offset.stopAnimation();
    });
  }

  const position = anchor ? menuPosition(anchor, { width, height }, {
    ...dimensions, top: insets.top, bottom: insets.bottom,
  }) : { left: 0, top: 0 };

  return (
    <>
      <Pressable
        ref={trigger}
        testID="action-menu-trigger"
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled, expanded: open }}
        disabled={disabled}
        onPress={show}
        hitSlop={4}
        style={({ pressed }) => [styles.trigger, glassRim(), { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}>
        <AppIcon name={{ ios: 'ellipsis', android: 'more_horiz', web: 'more_horiz' }} size={20} tintColor={Colors.text} fallback="…" />
      </Pressable>
      {open ? (
        <Modal transparent animationType="none" statusBarTranslucent onRequestClose={dismiss}
          onShow={() => {
            if (!anchor || generation.current !== anchor.epoch || !eligibleRef.current) return;
            shown.current = true;
            enter(anchor.epoch);
          }}>
          <View style={styles.overlay} pointerEvents={interactive ? 'auto' : 'none'} testID="action-menu-overlay">
            <Pressable
              testID="action-menu-backdrop"
              style={StyleSheet.absoluteFill}
              onPress={dismiss}
              accessible={false}
              importantForAccessibility="no"
            />
            <Animated.View
              testID="action-menu-surface"
              accessibilityViewIsModal
              accessibilityRole="menu"
              accessibilityLabel={label}
              accessibilityElementsHidden={!interactive}
              importantForAccessibility={interactive ? 'auto' : 'no-hide-descendants'}
              onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
              style={[
                styles.menu, glassRim(), position,
                {
                  width, maxHeight: dimensions.height - insets.top - insets.bottom - Spacing.four,
                  opacity, transform: [{ translateY: offset }],
                },
              ]}>
              <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.tint]} />
              <ScrollView style={styles.menuList} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                {items.map((item) => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="menuitem"
                    accessibilityLabel={item.label}
                    accessibilityState={{ disabled: item.disabled }}
                    disabled={item.disabled}
                    onPress={() => {
                      if (selecting.current || !interactiveRef.current || item.disabled ||
                        !anchor || generation.current !== anchor.epoch || !eligibleRef.current) return;
                      selecting.current = true;
                      // Never waits on the exit animation: an incoming page
                      // must not be blocked by a fade that outside taps and
                      // Back are still allowed to play.
                      hideImmediately();
                      item.onPress();
                    }}
                    style={({ pressed }) => [
                      styles.item,
                      { backgroundColor: pressed ? Colors.backgroundSelected : 'transparent', opacity: item.disabled ? 0.45 : 1 },
                    ]}>
                    <ThemedText type="smallBold" themeColor={item.destructive ? 'danger' : 'text'}>
                      {item.label}
                    </ThemedText>
                  </Pressable>
                ))}
              </ScrollView>
            </Animated.View>
          </View>
        </Modal>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  trigger: { width: ControlHeight.regular, height: ControlHeight.regular, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.pill, backgroundColor: Colors.glassStrong },
  overlay: { flex: 1 },
  menu: { position: 'absolute', borderRadius: Radius.control, padding: Spacing.half, backgroundColor: Colors.background, overflow: 'hidden' },
  menuList: { flexGrow: 0 },
  tint: { backgroundColor: Colors.glassStrong },
  item: { minHeight: 48, justifyContent: 'center', paddingHorizontal: Spacing.two, paddingVertical: Spacing.one, borderRadius: Radius.tag },
});
