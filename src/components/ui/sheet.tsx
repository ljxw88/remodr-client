import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { glassRim } from '@/components/ui/glass-surface';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type ModalProps = {
  children: ReactNode;
  /** Accessible name for the scrim, which dismisses the sheet. */
  closeLabel: string;
  onClose: () => void;
  /** Blocks dismissal while work is in flight. */
  busy?: boolean;
  avoidKeyboard?: boolean;
  /** For sheets that stay mounted and toggle, rather than mounting on demand. */
  visible?: boolean;
};

/**
 * The scrim and window a sheet lives in.
 *
 * Fades rather than slides. `animationType="slide"` moves the whole modal
 * window, which drags the scrim up from the bottom edge as a travelling grey
 * rectangle. A scrim is meant to darken in place; when it moves, the effect
 * reads as a sheet of paper sliding over the screen rather than the app
 * dimming behind a panel. The panel still slides — see `SheetPanel` — but it
 * does so over a scrim that only darkens.
 */
export function SheetModal({
  children,
  closeLabel,
  onClose,
  busy = false,
  avoidKeyboard = false,
  visible = true,
}: ModalProps) {
  const Overlay = avoidKeyboard ? KeyboardAvoidingView : View;

  return (
    <Modal
      animationType="fade"
      transparent
      statusBarTranslucent
      visible={visible}
      onRequestClose={busy ? undefined : onClose}>
      <Overlay
        behavior={avoidKeyboard && Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.overlay}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
          disabled={busy}
          onPress={onClose}
          style={styles.backdrop}
        />
        {children}
      </Overlay>
    </Modal>
  );
}

/**
 * The panel itself: grab handle, glass surface, and the slide up from the
 * bottom edge.
 *
 * It travels its own measured height rather than a fixed guess, so a short
 * sheet and a full-height one both start just off screen and arrive together.
 * The panel is hidden until that measurement lands, otherwise it would show
 * for one frame already at rest.
 *
 * The surface is opaque, unlike every other surface in the app. A sheet renders
 * in its own window, so there is no blur available to soften what sits behind
 * it — a translucent panel just ghosts the list's text through its own, which
 * reads as a rendering fault rather than as glass. It earns its place in the
 * material family through the rim and the tint instead.
 */
export function SheetPanel({
  children,
  style,
  visible = true,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Replays the entrance for sheets that stay mounted and toggle. */
  visible?: boolean;
}) {
  const theme = useTheme();
  // A state initialiser rather than a ref: React Compiler rejects reading a
  // ref during render, and this feeds an animated style directly.
  const [enter] = useState(() => new Animated.Value(0));
  const [height, setHeight] = useState(0);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.height;
    setHeight((current) => (Math.abs(current - next) < 1 ? current : next));
  }, []);

  useEffect(() => {
    if (height === 0) {
      return;
    }
    if (!visible) {
      enter.setValue(0);
      return;
    }
    Animated.timing(enter, {
      toValue: 1,
      duration: 340,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [enter, height, visible]);

  const translateY = enter.interpolate({
    inputRange: [0, 1],
    outputRange: [height, 0],
  });

  return (
    <Animated.View
      onLayout={onLayout}
      style={[
        styles.sheet,
        glassRim(),
        {
          backgroundColor: theme.chrome,
          shadowColor: theme.glassShadow,
          opacity: height === 0 ? 0 : 1,
          transform: [{ translateY }],
        },
        style,
      ]}>
      <View style={[styles.handle, { backgroundColor: theme.glassHighlight }]} />
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  backdrop: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  sheet: {
    maxHeight: '92%',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two + Spacing.half,
    paddingTop: Spacing.one,
    borderTopLeftRadius: Radius.glass,
    borderTopRightRadius: Radius.glass,
    elevation: 20,
    shadowOffset: { width: 0, height: -10 },
    shadowOpacity: 1,
    shadowRadius: 28,
  },
  handle: {
    width: 38,
    height: 4,
    alignSelf: 'center',
    borderRadius: Radius.pill,
  },
});
