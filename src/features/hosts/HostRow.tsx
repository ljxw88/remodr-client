import { Pressable, StyleSheet, View } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { ThemedText } from '@/components/themed-text';
import { Fonts, Radius, Spacing } from '@/constants/theme';
import type { HostProfile } from '@/domain/hosts';
import { useHostSession } from '@/features/connection/use-host-session';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  host: HostProfile;
  onPress: () => void;
};

export function HostRow({ host, onPress }: Props) {
  const theme = useTheme();
  const session = useHostSession(host.id);
  const connected = session?.status === 'connected';
  const status = connected ? 'Connected' : session?.status === 'connecting' ? 'Connecting…' : 'Offline';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${host.name}, ${host.username} at ${host.hostname} port ${host.port}, ${status}`}
      accessibilityHint="Opens server details"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: pressed ? theme.backgroundSelected : theme.backgroundElement,
          borderColor: theme.border,
          shadowColor: theme.glassShadow,
          transform: [{ scale: pressed ? 0.99 : 1 }],
        },
      ]}>
      <View style={[styles.iconFrame, { backgroundColor: theme.accentSoft }]}>
        <AppIcon
          name={{ ios: 'server.rack', android: 'dns', web: 'dns' }}
          size={22}
          tintColor={theme.text}
          fallback="□"
        />
      </View>
      <View style={styles.content}>
        <View style={styles.top}>
          <ThemedText type="section" style={styles.name} numberOfLines={1}>
            {host.name}
          </ThemedText>
          <View
            style={[
              styles.status,
              {
                backgroundColor: connected ? theme.successSoft : theme.glass,
                borderColor: connected ? theme.success : theme.border,
              },
            ]}>
            <View
              style={[
                styles.statusDot,
                { backgroundColor: connected ? theme.success : theme.textMuted },
              ]}
            />
            <ThemedText
              type="caption"
              style={{ color: connected ? theme.success : theme.textMuted }}>
              {status}
            </ThemedText>
          </View>
        </View>
        <ThemedText
          type="caption"
          themeColor="textSecondary"
          numberOfLines={1}
          style={styles.endpoint}>
          {host.username}@{host.hostname}:{host.port}
        </ThemedText>
        {host.group ? (
          <ThemedText type="caption" themeColor="textMuted" numberOfLines={1}>
            {host.group}
          </ThemedText>
        ) : null}
      </View>
      <AppIcon
        name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
        size={18}
        tintColor={theme.textMuted}
        fallback="›"
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: Radius.glass,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.two,
    gap: Spacing.two,
    minHeight: 88,
    elevation: 3,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 1,
    shadowRadius: 18,
  },
  iconFrame: {
    width: 48,
    height: 48,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flex: 1,
    gap: Spacing.half,
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  name: {
    flex: 1,
  },
  endpoint: {
    fontFamily: Fonts.mono,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.half,
    borderWidth: 1,
    borderRadius: Radius.pill,
    paddingHorizontal: Spacing.one,
    paddingVertical: 3,
  },
  statusDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
  },
});
