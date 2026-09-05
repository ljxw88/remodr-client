import { useFocusEffect, useIsFocused } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Keyboard, Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { AppIcon } from '@/components/ui/app-icon';
import { glassRim } from '@/components/ui/glass-surface';
import { Colors, ControlHeight, Radius, Spacing } from '@/constants/theme';

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
 * its transparent backdrop does not dim or resize the conversation. */
export function ActionMenu({ label, items, disabled = false }: {
  label: string; items: ActionMenuItem[]; disabled?: boolean;
}) {
  const trigger = useRef<View | null>(null);
  const focused = useIsFocused();
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [height, setHeight] = useState(items.length * ControlHeight.row + Spacing.two);
  const selecting = useRef(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const open = anchor != null && focused;
  const width = Math.min(240, dimensions.width - Spacing.four);

  useFocusEffect(useCallback(() => {
    return () => {
      generation.current++;
      pending.current = false;
      setAnchor(null);
    };
  }, []));

  function close() {
    generation.current++;
    pending.current = false;
    setAnchor(null);
  }

  function show() {
    if (disabled || pending.current) return;
    Keyboard.dismiss();
    pending.current = true;
    selecting.current = false;
    const token = ++generation.current;
    trigger.current?.measureInWindow((x, y, measuredWidth, measuredHeight) => {
      if (token !== generation.current) return;
      pending.current = false;
      setAnchor({ x, y, width: measuredWidth, height: measuredHeight });
    });
  }

  const position = anchor ? menuPosition(anchor, { width, height }, {
    ...dimensions, top: insets.top, bottom: insets.bottom,
  }) : { left: 0, top: 0 };

  return (
    <>
      <Pressable
        ref={trigger}
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
        <Modal transparent animationType="none" statusBarTranslucent onRequestClose={close}>
          <View style={styles.overlay}>
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={close}
              accessible={false}
              importantForAccessibility="no"
            />
            <View
              accessibilityViewIsModal
              accessibilityRole="menu"
              accessibilityLabel={label}
              onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
              style={[styles.menu, glassRim(), position, { width, maxHeight: dimensions.height - insets.top - insets.bottom - Spacing.four }]}>
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
                      if (selecting.current) return;
                      selecting.current = true;
                      close();
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
            </View>
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
