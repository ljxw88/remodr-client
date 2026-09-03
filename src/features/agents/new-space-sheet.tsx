import { useState } from 'react';
import { Keyboard, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { AppButton } from '@/components/ui/app-button';
import { AppIcon } from '@/components/ui/app-icon';
import { SheetHeader, SheetModal, SheetPanel } from '@/components/ui/sheet';
import { TextField } from '@/components/ui/text-field';
import { Radius, Spacing } from '@/constants/theme';
import type { CreateSpaceInput } from '@/domain/herdr';
import { RemoteFolderPicker } from '@/features/files/remote-folder-picker';
import { useDockContentInset } from '@/features/navigation/floating-dock';
import { useTheme } from '@/hooks/use-theme';
import { toUserMessage } from '@/utils/user-error';

type Props = {
  deviceId: string;
  deviceName: string;
  onClose: () => void;
  onCreate: (input: CreateSpaceInput) => Promise<void>;
};

export function NewSpaceSheet({
  deviceId,
  deviceName,
  onClose,
  onCreate,
}: Readonly<Props>) {
  const theme = useTheme();
  const dockContentInset = useDockContentInset();
  const [label, setLabel] = useState('');
  const [cwd, setCwd] = useState('~/');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFolderPicker, setShowFolderPicker] = useState(false);

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
    <SheetModal
      closeLabel="Close new space"
      onClose={onClose}
      busy={creating}
      avoidKeyboard
      interceptDismiss={showFolderPicker ? () => setShowFolderPicker(false) : undefined}>
      {(close) => (
        <>
      {!showFolderPicker ? (
        <SheetPanel>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={[
              styles.sheetContent,
              { paddingBottom: dockContentInset },
            ]}>
            <SheetHeader
              title="New space"
              subtitle="Create a Herdr workspace from a folder."
              onClose={close}
              busy={creating}
            />

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
              rightAccessory={
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Browse remote folders"
                  disabled={creating}
                  onPress={() => {
                    Keyboard.dismiss();
                    setShowFolderPicker(true);
                  }}
                  style={({ pressed }) => [
                    styles.folderPickerButton,
                    {
                      backgroundColor: theme.accentSoft,
                      opacity: controlOpacity(creating, pressed),
                    },
                  ]}>
                  <AppIcon
                    name={{ ios: 'folder', android: 'folder', web: 'folder' }}
                    size={20}
                    tintColor={theme.accent}
                    fallback="□"
                  />
                </Pressable>
              }
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
        </SheetPanel>
      ) : (
        <RemoteFolderPicker
          deviceId={deviceId}
          deviceName={deviceName}
          initialPath={cwd}
          onClose={() => setShowFolderPicker(false)}
          onSelect={(path) => {
            setCwd(path);
            setShowFolderPicker(false);
          }}
        />
      )}
        </>
      )}
    </SheetModal>
  );
}

function controlOpacity(disabled: boolean, pressed: boolean): number {
  if (disabled) {
    return 0.4;
  }
  return pressed ? 0.68 : 1;
}

const styles = StyleSheet.create({
  sheetContent: {
    gap: Spacing.three,
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
  folderPickerButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
  },
});
