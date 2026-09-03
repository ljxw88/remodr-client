import { Pressable, StyleSheet, View } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  path: string;
  /** The folder above, or null at the root, which disables the up control. */
  parent: string | null;
  onNavigate: (path: string) => void;
};

/** Where you are on the remote host, and the way back up. */
export function RemotePathBar({ path, parent, onNavigate }: Props) {
  const theme = useTheme();

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Parent folder"
        accessibilityState={{ disabled: parent == null }}
        disabled={parent == null}
        onPress={() => {
          if (parent) {
            onNavigate(parent);
          }
        }}
        style={({ pressed }) => [
          styles.parent,
          {
            backgroundColor: theme.glassStrong,
            borderColor: theme.glassBorder,
            opacity: parent == null ? 0.38 : pressed ? 0.68 : 1,
          },
        ]}>
        <AppIcon
          name={{ ios: 'chevron.up', android: 'arrow_upward', web: 'arrow_upward' }}
          size={19}
          tintColor={theme.textSecondary}
          fallback="↑"
        />
      </Pressable>
      <View
        style={[
          styles.path,
          { backgroundColor: theme.glassStrong, borderColor: theme.glassBorder },
        ]}>
        <AppIcon
          name={{ ios: 'folder', android: 'folder', web: 'folder' }}
          size={18}
          tintColor={theme.accent}
          fallback="□"
        />
        <ThemedText type="code" numberOfLines={1} style={styles.text}>
          {path === '~' ? '~/' : path}
        </ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  parent: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderRadius: Radius.pill,
  },
  path: {
    minHeight: 44,
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.control,
  },
  text: {
    flex: 1,
  },
});
