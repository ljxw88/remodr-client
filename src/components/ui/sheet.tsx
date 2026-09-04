import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
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

import { AppIcon } from '@/components/ui/app-icon';
import { glassRim } from '@/components/ui/glass-surface';
import { Radius, Spacing } from '@/constants/theme';
import { useReduceMotion } from '@/hooks/use-reduce-motion';
import { useTheme } from '@/hooks/use-theme';

const OPEN_MS = 340;
const CLOSE_MS = 240;

type SheetMotion = {
  /** 0 while the sheet is off screen, 1 once it has arrived. */
  progress: Animated.Value;
  panelHeight: number;
  reportPanelHeight: (height: number) => void;
};

const SheetMotionContext = createContext<SheetMotion | null>(null);

type ModalProps = {
  /**
   * Given a `close` that plays the exit before the sheet goes away. Use it for
   * every dismissal inside the sheet — a close button, or finishing the task —
   * so they all leave the same way.
   */
  children: ReactNode | ((close: () => void) => ReactNode);
  /** Accessible name for the scrim, which dismisses the sheet. */
  closeLabel: string;
  onClose: () => void;
  /** Blocks dismissal while work is in flight. */
  busy?: boolean;
  avoidKeyboard?: boolean;
  /** For sheets that stay mounted and toggle, rather than mounting on demand. */
  visible?: boolean;
  /**
   * Handles a scrim tap or back gesture without closing the sheet, for a sheet
   * showing a nested step that should be backed out of first.
   */
  interceptDismiss?: () => void;
};

/**
 * The scrim and window a sheet lives in, and the motion both it and its panel
 * animate against.
 *
 * The scrim only ever fades; the panel does the travelling. `animationType`
 * cannot express that — `slide` moves the whole modal window and drags the
 * scrim up from the bottom edge as a grey rectangle, which reads as a sheet of
 * paper sliding over the screen rather than the app dimming behind a panel. So
 * the window animates nothing and this owns both directions instead, which is
 * also what lets the panel slide back down on the way out: React Native would
 * otherwise tear the modal down the moment the parent stopped rendering it.
 */
export function SheetModal({
  children,
  closeLabel,
  onClose,
  busy = false,
  avoidKeyboard = false,
  visible = true,
  interceptDismiss,
}: ModalProps) {
  const [progress] = useState(() => new Animated.Value(0));
  const [panelHeight, setPanelHeight] = useState(0);
  const shouldReduceMotion = useReduceMotion();
  const [closing, setClosing] = useState(false);

  const reportPanelHeight = useCallback((height: number) => {
    setPanelHeight((current) => (Math.abs(current - height) < 1 ? current : height));
  }, []);

  useEffect(() => {
    // A re-layout mid-exit — the keyboard, a content change, a rotation —
    // would otherwise restart the entrance and cancel the close, stranding a
    // sheet that the user has already dismissed.
    if (panelHeight === 0 || closing) {
      return;
    }
    if (!visible) {
      progress.setValue(0);
      return;
    }
    if (shouldReduceMotion()) {
      progress.setValue(1);
      return;
    }
    Animated.timing(progress, {
      toValue: 1,
      duration: OPEN_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [closing, panelHeight, progress, shouldReduceMotion, visible]);

  const close = useCallback(() => {
    if (closing) {
      return;
    }
    setClosing(true);
    if (shouldReduceMotion()) {
      progress.setValue(0);
      onClose();
      return;
    }
    // Closes on interruption too. Waiting for `finished` means an animation cut
    // short leaves the sheet open with no way to dismiss it.
    Animated.timing(progress, {
      toValue: 0,
      duration: CLOSE_MS,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(() => {
      onClose();
    });
  }, [closing, onClose, progress, shouldReduceMotion]);

  const dismiss = useCallback(() => {
    if (busy) {
      return;
    }
    if (interceptDismiss) {
      interceptDismiss();
      return;
    }
    close();
  }, [busy, close, interceptDismiss]);

  const Overlay = avoidKeyboard ? KeyboardAvoidingView : View;

  return (
    <Modal
      animationType="none"
      transparent
      statusBarTranslucent
      visible={visible}
      onRequestClose={dismiss}>
      <Overlay
        behavior={avoidKeyboard && Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.overlay}>
        <Animated.View style={[styles.backdrop, { opacity: progress }]}>
          {/*
            Hidden from screen readers on purpose. It covers the screen and is
            rendered before the panel, so TalkBack would otherwise land on a
            full-screen "close" button before reaching the sheet's own title.
            Every sheet carries a labelled close control, and the back gesture
            works, so nothing is lost by taking this out of the traversal.
          */}
          <Pressable
            accessible={false}
            importantForAccessibility="no"
            accessibilityLabel={closeLabel}
            disabled={busy}
            onPress={dismiss}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
        <SheetMotionContext.Provider value={{ progress, panelHeight, reportPanelHeight }}>
          {typeof children === 'function' ? children(close) : children}
        </SheetMotionContext.Provider>
      </Overlay>
    </Modal>
  );
}

/**
 * The panel itself: grab handle, surface, and the travel to and from the
 * bottom edge.
 *
 * It moves its own measured height, so a short sheet and a full-height one
 * both start just off screen and arrive together. It stays hidden until that
 * measurement lands, otherwise it shows for one frame already at rest.
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
  onClose,
  busy = false,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Draws the close control. Omit for a sheet that dismisses another way. */
  onClose?: () => void;
  busy?: boolean;
}) {
  const theme = useTheme();
  const motion = useContext(SheetMotionContext);
  if (!motion) {
    throw new Error('SheetPanel must be used inside SheetModal');
  }
  const { progress, panelHeight, reportPanelHeight } = motion;

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      reportPanelHeight(event.nativeEvent.layout.height);
    },
    [reportPanelHeight],
  );

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [panelHeight, 0],
  });

  return (
    <Animated.View
      onLayout={onLayout}
      style={[
        styles.sheet,
        glassRim(),
        {
          // The canvas at its darkest, which is what a panel down here would
          // be sitting on.
          backgroundColor: theme.background,
          shadowColor: theme.glassShadow,
          opacity: panelHeight === 0 ? 0 : 1,
          transform: [{ translateY }],
        },
        style,
      ]}>
      {/*
        The same plate every other surface in the app is made of, laid over an
        opaque base instead of a blurred one. Composited against the foot of
        the canvas it lands on the same colour a real glass panel would, so the
        sheet reads as the same material as the chrome around it rather than as
        a grey slab.
      */}
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.glassStrong }]}
      />
      <View style={[styles.handle, { backgroundColor: theme.glassHighlight }]} />
      {onClose ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          disabled={busy}
          onPress={onClose}
          hitSlop={Spacing.one}
          style={({ pressed }) => [styles.close, { opacity: pressed ? 0.6 : 1 }]}>
          <AppIcon
            name={{ ios: 'xmark', android: 'close', web: 'close' }}
            size={20}
            tintColor={theme.textSecondary}
            fallback="×"
          />
        </Pressable>
      ) : null}
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  close: {
    position: 'absolute',
    top: Spacing.one,
    right: Spacing.one,
    zIndex: 1,
    // 48dp is Android's minimum touch target; 44 is the iOS figure.
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
