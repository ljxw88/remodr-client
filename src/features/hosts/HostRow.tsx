import { Pressable, StyleSheet, View } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { MarqueeText } from '@/components/ui/marquee-text';
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
  const connecting = session?.status === 'connecting';
  const statusColor = connected
    ? theme.success
    : connecting
      ? theme.warning
      : theme.textMuted;
  const status = connected ? 'Connected' : connecting ? 'Connecting…' : 'Offline';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${host.name}, ${host.username} at ${host.hostname} port ${host.port}, ${status}`}
      accessibilityHint="Opens server details"
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          backgroundColor: pressed ? theme.backgroundSelected : theme.glassStrong,
          borderColor: theme.glassBorder,
          shadowColor: theme.glassShadow,
          transform: [{ scale: pressed ? 0.99 : 1 }],
        },
      ]}>
      <View style={[styles.iconFrame, { backgroundColor: theme.accentSoft }]}>
        <AppIcon
          name={{ ios: 'server.rack', android: 'dns', web: 'dns' }}
          size={22}
          tintColor={theme.accent}
          fallback="□"
        />
      </View>
      <View style={styles.content}>
        <View style={styles.top}>
          <MarqueeText
            type="caption"
            style={styles.name}
            containerStyle={styles.nameContainer}>
            {host.name}
          </MarqueeText>
          <View
            accessibilityLabel={status}
            style={[
              styles.statusDot,
              {
                backgroundColor: connected || connecting ? statusColor : 'transparent',
                borderColor: statusColor,
              },
            ]}
          />
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
    gap: Spacing.two,
    minHeight: 68,
  },
  iconFrame: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    flex: 1,
    gap: 4,
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  nameContainer: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    fontFamily: Fonts.semibold,
    fontWeight: 600,
  },
  endpoint: {
    fontFamily: Fonts.mono,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderWidth: 1.5,
    borderRadius: 3.5,
  },
});
