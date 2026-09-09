import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { GlassSurface } from '@/components/ui/glass-surface';
import { Screen } from '@/components/ui/screen';
import { ScrollEdgeFrame } from '@/components/ui/scroll-edge-frame';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import {
  useDockContentInset,
  useDockScrollHandler,
} from '@/features/navigation/floating-dock';
import { useAppSettings } from '@/hooks/use-app-settings';
import { useTheme } from '@/hooks/use-theme';

type SettingRowProps = {
  icon: {
    ios:
      | 'key'
      | 'checkmark.shield'
      | 'info.circle'
      | 'stethoscope'
      | 'arrow.left.and.right';
    android: 'key' | 'security' | 'info' | 'troubleshoot' | 'swap_horiz';
    web: 'key' | 'security' | 'info' | 'troubleshoot' | 'swap_horiz';
  };
  label: string;
  value: string;
  onPress?: () => void;
};

export default function SettingsScreen() {
  const version = Constants.expoConfig?.version ?? '0.1.0';
  const buildNumber =
    Constants.expoConfig?.android?.versionCode ??
    Constants.expoConfig?.ios?.buildNumber;
  const versionDisplay = buildNumber ? `v${version} (${buildNumber})` : `v${version}`;
  const onDockScroll = useDockScrollHandler();
  const dockContentInset = useDockContentInset();
  const { marqueeEnabled, setMarqueeEnabled } = useAppSettings();

  return (
    <Screen includeTopSafeArea>
      <ScrollEdgeFrame onScroll={onDockScroll}>
        {(edge) => (
          <ScrollView
            {...edge}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={[styles.content, { paddingBottom: dockContentInset }]}>
            <SettingsGroup title="Security">
              <SettingRow
                icon={{ ios: 'key', android: 'key', web: 'key' }}
                label="Credentials"
                value="Android Keystore"
              />
              <SettingDivider />
              <SettingRow
                icon={{ ios: 'checkmark.shield', android: 'security', web: 'security' }}
                label="Host keys"
                value="Strict verification"
              />
            </SettingsGroup>

            <SettingsGroup title="About">
              <SettingRow
                icon={{ ios: 'info.circle', android: 'info', web: 'info' }}
                label="Version"
                value={versionDisplay}
              />
            </SettingsGroup>

            <SettingsGroup title="Developer">
              <SettingSwitchRow
                icon={{ ios: 'arrow.left.and.right', android: 'swap_horiz', web: 'swap_horiz' }}
                label="Animate long titles"
                value={marqueeEnabled}
                onValueChange={(enabled) => void setMarqueeEnabled(enabled)}
              />
              <SettingDivider />
              <SettingRow
                icon={{ ios: 'stethoscope', android: 'troubleshoot', web: 'troubleshoot' }}
                label="Diagnostics"
                value="Open →"
                onPress={() => router.push('/diagnostics')}
              />
            </SettingsGroup>
          </ScrollView>
        )}
      </ScrollEdgeFrame>
    </Screen>
  );
}

function SettingSwitchRow({
  icon,
  label,
  value,
  onValueChange,
}: {
  icon: SettingRowProps['icon'];
  label: string;
  value: boolean;
  onValueChange: (val: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <View style={styles.row}>
      <View style={[styles.iconFrame, { backgroundColor: theme.accentSoft }]}>
        <AppIcon name={icon} size={20} tintColor={theme.accent} fallback="↔" />
      </View>
      <ThemedText type="small" style={styles.rowLabel}>
        {label}
      </ThemedText>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: theme.border, true: theme.accent }}
        thumbColor={value ? theme.onAccent : theme.textMuted}
      />
    </View>
  );
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.group}>
      <ThemedText type="label" themeColor="textMuted" style={styles.groupTitle}>
        {title.toUpperCase()}
      </ThemedText>
      <GlassSurface strength="strong" style={styles.card}>
        {children}
      </GlassSurface>
    </View>
  );
}

function SettingRow({ icon, label, value, onPress }: SettingRowProps) {
  const theme = useTheme();

  const row = (
    <View style={styles.row}>
      <View style={[styles.iconFrame, { backgroundColor: theme.accentSoft }]}>
        <AppIcon name={icon} size={20} tintColor={theme.accent} fallback="•" />
      </View>
      <ThemedText type="small" style={styles.rowLabel}>
        {label}
      </ThemedText>
      <ThemedText type="small" themeColor={onPress ? 'accent' : 'textMuted'} numberOfLines={1}>
        {value}
      </ThemedText>
    </View>
  );

  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}, ${value}`}
        onPress={onPress}
        style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}>
        {row}
      </Pressable>
    );
  }

  return row;
}

function SettingDivider() {
  const theme = useTheme();
  return <View style={[styles.divider, { backgroundColor: theme.border }]} />;
}

const styles = StyleSheet.create({
  content: {
    gap: Spacing.three,
    paddingTop: Spacing.one,
  },
  group: {
    gap: Spacing.one,
  },
  groupTitle: {
    letterSpacing: 0.7,
    paddingHorizontal: Spacing.half,
  },
  card: {},
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
  },
  iconFrame: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },
  rowLabel: {
    flex: 1,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 66,
  },
});
