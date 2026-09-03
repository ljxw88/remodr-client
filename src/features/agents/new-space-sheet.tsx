import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { AppIcon } from '@/components/ui/app-icon';
import { TextField } from '@/components/ui/text-field';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import type { CreateSpaceInput } from '@/domain/herdr';
import { useDockContentInset } from '@/features/navigation/floating-dock';
import { useTheme } from '@/hooks/use-theme';
import { toUserMessage } from '@/utils/user-error';

type Props = {
  deviceName: string;
  onClose: () => void;
  onCreate: (input: CreateSpaceInput) => Promise<void>;
};

export function NewSpaceSheet({ deviceName, onClose, onCreate }: Props) {
  const theme = useTheme();
  const dockContentInset = useDockContentInset();
  const [label, setLabel] = useState('');
  const [cwd, setCwd] = useState('~/');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (!cwd.trim() || creating) {
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await onCreate({ cwd, label });
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal
      animationType="slide"
      transparent
      statusBarTranslucent
      visible
      onRequestClose={creating ? undefined : onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.overlay}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close new space"
          disabled={creating}
          onPress={onClose}
          style={styles.backdrop}
        />
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: theme.chrome,
              borderColor: theme.glassBorder,
              shadowColor: theme.glassShadow,
            },
          ]}>
          <View style={[styles.handle, { backgroundColor: theme.border }]} />
          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={[
              styles.sheetContent,
              { paddingBottom: dockContentInset },
            ]}>
          <View style={styles.header}>
            <View style={styles.titleCopy}>
              <ThemedText type="heading">New space</ThemedText>
              <ThemedText type="caption" themeColor="textSecondary">
                Create a Herdr workspace from a folder on this device.
              </ThemedText>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              disabled={creating}
              onPress={onClose}
              style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
              <AppIcon
                name={{ ios: 'xmark', android: 'close', web: 'close' }}
                size={20}
                tintColor={theme.textSecondary}
                fallback="×"
              />
            </Pressable>
          </View>

          <View
            style={[
              styles.device,
              { backgroundColor: theme.backgroundElement, borderColor: theme.border },
            ]}>
            <View style={[styles.deviceIcon, { backgroundColor: theme.accentSoft }]}>
              <AppIcon
                name={{ ios: 'server.rack', android: 'dns', web: 'dns' }}
                size={20}
                tintColor={theme.accent}
                fallback="□"
              />
            </View>
            <View style={styles.deviceCopy}>
              <ThemedText type="label" themeColor="textMuted">
                DEVICE
              </ThemedText>
              <ThemedText type="smallBold" numberOfLines={1}>
                {deviceName}
              </ThemedText>
            </View>
          </View>

          <TextField
            label="Space name (optional)"
            value={label}
            onChangeText={setLabel}
            placeholder="Uses the folder name"
            autoCapitalize="sentences"
          />
          <TextField
            label="Root folder"
            value={cwd}
            onChangeText={setCwd}
            placeholder="~/Projects/my-app"
            autoCapitalize="none"
            autoCorrect={false}
          />

          {error ? (
            <ThemedText accessibilityLiveRegion="polite" type="caption" themeColor="danger">
              {error}
            </ThemedText>
          ) : null}

          <AppButton
            label={creating ? 'Creating space…' : 'Create space'}
            disabled={creating || !cwd.trim()}
            onPress={() => void create()}
          />
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
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
  sheetContent: {
    gap: Spacing.three,
  },
  handle: {
    width: 38,
    height: 4,
    alignSelf: 'center',
    borderRadius: Radius.pill,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.two,
  },
  titleCopy: {
    flex: 1,
    gap: Spacing.half,
  },
  close: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.pill,
  },
  device: {
    minHeight: 62,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.one + Spacing.half,
    borderWidth: 1,
    borderRadius: Radius.control,
  },
  deviceIcon: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },
  deviceCopy: {
    flex: 1,
    gap: 2,
  },
  pressed: {
    opacity: 0.6,
  },
});
