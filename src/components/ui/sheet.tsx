import { useEffect, useState, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

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
 * dimming behind a panel. The panel does the moving instead — see `SheetPanel`.
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
 * The panel itself: grab handle, chrome surface, and a short rise on entry.
 *
 * The rise is deliberately small. Travelling the full height of the screen
 * announces the transition far more than it needs to; a short lift gives the
 * panel direction without the whole screen appearing to move.
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

  useEffect(() => {
    if (!visible) {
      enter.setValue(0);
      return;
    }
    Animated.timing(enter, {
      toValue: 1,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [enter, visible]);

  const translateY = enter.interpolate({ inputRange: [0, 1], outputRange: [28, 0] });

  return (
    <Animated.View
      style={[
        styles.sheet,
        {
          backgroundColor: theme.chrome,
          borderColor: theme.glassBorder,
          shadowColor: theme.glassShadow,
          opacity: enter,
          transform: [{ translateY }],
        },
        style,
      ]}>
      <View style={[styles.handle, { backgroundColor: theme.border }]} />
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
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  sheet: {
    maxHeight: '92%',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two + Spacing.half,
    paddingTop: Spacing.one,
    borderWidth: 1,
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
