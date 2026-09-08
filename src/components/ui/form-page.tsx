import { router, Stack, useFocusEffect, useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { BackHandler, Keyboard, Pressable, ScrollView, StyleSheet, View, type TextInput } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { AppButton } from '@/components/ui/app-button';
import { AppIcon } from '@/components/ui/app-icon';
import { FormKeyboardContext } from '@/components/ui/form-keyboard-context';
import { glassRim } from '@/components/ui/glass-surface';
import { SkeletonBlock, SkeletonGroup, SkeletonLine } from '@/components/ui/skeleton';
import { Colors, ControlHeight, MaxFormWidth, Radius, Spacing } from '@/constants/theme';
import { fieldScrollOffset, useKeyboardOverlap } from '@/hooks/use-keyboard-overlap';

export function leaveForm() {
  Keyboard.dismiss();
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

type Props = {
  title: string;
  children?: ReactNode;
  footer?: ReactNode;
  onBack?: () => void;
  busy?: boolean;
  scroll?: boolean;
};

export function FormPage({ title, children, footer, onBack = leaveForm, busy = false, scroll = true }: Props) {
  const insets = useSafeAreaInsets();
  const focused = useIsFocused();
  const scroller = useRef<ScrollView | null>(null);
  const focusedInput = useRef<TextInput | null>(null);
  const revealFrame = useRef<number | null>(null);
  const revealGeneration = useRef(0);
  const scrollOffset = useRef(0);
  const { ref: viewportRef, inset: keyboardInset, visible: keyboardVisible, measure: measureViewport } = useKeyboardOverlap(focused);

  const cancelReveal = useCallback(() => {
    revealGeneration.current++;
    if (revealFrame.current != null) cancelAnimationFrame(revealFrame.current);
    revealFrame.current = null;
  }, []);
  const reveal = useCallback(() => {
    cancelReveal();
    const token = revealGeneration.current;
    revealFrame.current = requestAnimationFrame(() => {
      revealFrame.current = null;
      const scrollView = scroller.current;
      const input = focusedInput.current;
      if (!focused || !scrollView || !input) return;
      // Native ScrollView's keyboard helper assumes a full-screen scroll view.
      // Measure this viewport instead, which already excludes header and footer.
      scrollView.getNativeScrollRef()?.measureInWindow((_x, top, _width, height) => {
        if (token !== revealGeneration.current || height <= 0 || input !== focusedInput.current) return;
        input.measureInWindow((_inputX, inputTop, _inputWidth, inputHeight) => {
          if (token !== revealGeneration.current || input !== focusedInput.current) return;
          const next = fieldScrollOffset(inputTop, inputHeight, top, height, scrollOffset.current);
          if (Math.abs(next - scrollOffset.current) > 1) scrollView.scrollTo({ y: next, animated: true });
        });
      });
    });
  }, [focused, cancelReveal]);
  const onFieldFocus = useCallback((input: TextInput | null) => {
    focusedInput.current = input;
    reveal();
  }, [reveal]);

  useEffect(() => {
    reveal();
    return cancelReveal;
  }, [keyboardInset, keyboardVisible, reveal, cancelReveal]);

  useFocusEffect(useCallback(() => {
    if (!busy) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, [busy]));

  return (
    <View testID="form-page" ref={viewportRef} collapsable={false} onLayout={measureViewport} style={styles.page}>
      <Stack.Screen options={{
        title,
        gestureEnabled: !busy,
        headerStyle: { backgroundColor: Colors.background },
        headerLeft: () => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            hitSlop={4}
            onPress={() => { Keyboard.dismiss(); onBack(); }}
            style={({ pressed }) => [styles.back, glassRim(), { opacity: busy ? 0.4 : pressed ? 0.7 : 1 }]}>
            <AppIcon name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }} size={20} tintColor={Colors.text} fallback="‹" />
          </Pressable>
        ),
      }} />
      <FormKeyboardContext.Provider value={onFieldFocus}>
        <View testID="form-viewport" style={[styles.viewport, {
          paddingBottom: keyboardInset + (footer || keyboardVisible ? 0 : insets.bottom),
          paddingLeft: insets.left,
          paddingRight: insets.right,
        }]}>
          {scroll ? (
            <ScrollView
              testID="form-scroll"
              ref={scroller}
              onLayout={reveal}
              onContentSizeChange={reveal}
              onScroll={(event) => { scrollOffset.current = event.nativeEvent.contentOffset.y; }}
              scrollEventThrottle={16}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              automaticallyAdjustKeyboardInsets={false}
              contentContainerStyle={styles.content}
              showsVerticalScrollIndicator={false}>
              {children}
            </ScrollView>
          ) : (
            <View style={styles.listContent}>{children}</View>
          )}
          {footer ? (
            <View
              testID="form-footer"
              style={[styles.footer, { paddingBottom: keyboardVisible ? Spacing.two : Math.max(insets.bottom, Spacing.two) }]}>
              {footer}
            </View>
          ) : null}
        </View>
      </FormKeyboardContext.Provider>
    </View>
  );
}

export function FormSection({ title, description, children, fill = false }: { title?: string; description?: string; children: ReactNode; fill?: boolean }) {
  return (
    <View style={[styles.section, fill && styles.fill]}>
      {title ? <ThemedText type="smallBold" themeColor="textSecondary">{title}</ThemedText> : null}
      <View style={[styles.group, fill && styles.listGroup]}>{children}</View>
      {description ? <ThemedText type="caption" themeColor="textMuted">{description}</ThemedText> : null}
    </View>
  );
}

export function SelectionRow({
  label, value, description, onPress, onLongPress, accessibilityHint, disabled = false, selected, accessory,
}: {
  label: string;
  value?: string;
  description?: string;
  onPress?: () => void;
  onLongPress?: () => void;
  accessibilityHint?: string;
  disabled?: boolean;
  selected?: boolean;
  accessory?: ReactNode;
}) {
  const content = (
    <>
      <View style={styles.rowCopy}>
        <ThemedText type="smallBold">{label}</ThemedText>
        {description ? <ThemedText type="caption" themeColor="textMuted">{description}</ThemedText> : null}
      </View>
      {value ? <ThemedText type="small" themeColor="textSecondary" style={styles.value}>{value}</ThemedText> : null}
      {accessory}
      {selected ? <AppIcon name={{ ios: 'checkmark', android: 'check', web: 'check' }} size={19} tintColor={Colors.accent} fallback="✓" />
        : onPress && selected == null ? <AppIcon name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }} size={19} tintColor={Colors.textMuted} fallback="›" /> : null}
    </>
  );
  return onPress || onLongPress ? (
    <Pressable
      accessibilityRole={selected == null ? 'button' : 'radio'}
      accessibilityLabel={[label, value, description].filter(Boolean).join(', ')}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled, selected, checked: selected }}
      disabled={disabled}
      onPress={onPress ? () => { Keyboard.dismiss(); onPress(); } : undefined}
      onLongPress={onLongPress ? () => { Keyboard.dismiss(); onLongPress(); } : undefined}
      style={({ pressed }) => [styles.row, { opacity: disabled ? 0.45 : 1, backgroundColor: pressed ? Colors.backgroundSelected : 'transparent' }]}>
      {content}
    </Pressable>
  ) : <View style={styles.row}>{content}</View>;
}

export function SelectionRowSkeleton({ label = 'Loading options' }: { label?: string }) {
  return (
    <SkeletonGroup label={label} style={styles.row}>
      <View style={styles.rowCopy}>
        <SkeletonLine width="58%" lineHeight={20} />
        <SkeletonLine width="76%" lineHeight={18} />
      </View>
      <SkeletonBlock width={19} height={19} radius={9.5} />
    </SkeletonGroup>
  );
}

export function FormError({ message }: { message?: string | null }) {
  return message ? <ThemedText type="small" themeColor="danger" accessibilityLiveRegion="polite">{message}</ThemedText> : null;
}

export function MissingFlow({ title = 'Form Unavailable' }: { title?: string }) {
  return (
    <FormPage title={title} footer={<AppButton label="Back to agents" onPress={() => router.dismissTo('/')} />}>
      <ThemedText type="heading">Start this action again</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        This form is no longer open. Return to Agents to review the current state before starting it again.
      </ThemedText>
    </FormPage>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: Colors.background },
  viewport: { flex: 1, width: '100%', maxWidth: MaxFormWidth, alignSelf: 'center' },
  content: { flexGrow: 1, gap: Spacing.three, padding: Spacing.two + Spacing.half },
  listContent: { flex: 1, gap: Spacing.two, paddingHorizontal: Spacing.two + Spacing.half, paddingTop: Spacing.two },
  footer: { gap: Spacing.one, padding: Spacing.two, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: Colors.border, backgroundColor: Colors.background },
  back: { width: ControlHeight.regular, height: ControlHeight.regular, marginRight: Spacing.one, borderRadius: Radius.pill, justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.glassStrong },
  section: { gap: Spacing.one },
  fill: { flex: 1 },
  listGroup: { flex: 1, backgroundColor: 'transparent', borderWidth: 0, borderRadius: 0 },
  group: { borderRadius: Radius.control, borderWidth: StyleSheet.hairlineWidth, borderColor: Colors.border, overflow: 'hidden', backgroundColor: Colors.backgroundElement },
  row: { minHeight: ControlHeight.row, flexDirection: 'row', alignItems: 'center', gap: Spacing.one, paddingHorizontal: Spacing.two, paddingVertical: Spacing.one + Spacing.half, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: Colors.border },
  rowCopy: { flex: 1, gap: Spacing.half },
  value: { flexShrink: 1, maxWidth: '57%', textAlign: 'right' },
});
