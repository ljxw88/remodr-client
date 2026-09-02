import { StyleSheet, View } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { AppButton } from '@/components/ui/app-button';
import { GlassSurface } from '@/components/ui/glass-surface';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
};

export function EmptyState({ title, body, actionLabel, onAction }: Props) {
  const theme = useTheme();

  return (
    <GlassSurface strength="strong" style={styles.container}>
      <View style={[styles.iconFrame, { backgroundColor: theme.accentSoft }]}>
        <AppIcon
          name={{ ios: 'server.rack', android: 'dns', web: 'dns' }}
          size={28}
          tintColor={theme.text}
          fallback="□"
        />
      </View>
      <View style={styles.copy}>
        <ThemedText type="heading" style={styles.center}>
          {title}
        </ThemedText>
        <ThemedText type="default" themeColor="textSecondary" style={styles.center}>
          {body}
        </ThemedText>
      </View>
      <View style={styles.action}>
        <AppButton label={actionLabel} onPress={onAction} />
      </View>
    </GlassSurface>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: 360,
    maxHeight: 480,
    gap: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.four,
  },
  iconFrame: {
    width: 64,
    height: 64,
    borderRadius: Radius.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: {
    maxWidth: 320,
    gap: Spacing.one,
  },
  action: {
    minWidth: 160,
  },
  center: {
    textAlign: 'center',
  },
});
