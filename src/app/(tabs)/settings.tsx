import Constants from 'expo-constants';
import { router } from 'expo-router';
import { ScrollView, StyleSheet, Switch, View } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { GlassSurface } from '@/components/ui/glass-surface';
import { AppButton } from '@/components/ui/app-button';
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
};

export default function SettingsScreen() {
  const version = Constants.expoConfig?.version ?? '1.0.0';
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
                value={version}
              />
            </SettingsGroup>

            <SettingsGroup title="Developer">
              <View>
                <SettingSwitchRow
                  icon={{ ios: 'arrow.left.and.right', android: 'swap_horiz', web: 'swap_horiz' }}
                  label="MarqueeText animation"
                  value={marqueeEnabled}
                  onValueChange={(enabled) => void setMarqueeEnabled(enabled)}
                />
                <SettingDivider />
                <SettingRow
                  icon={{ ios: 'stethoscope', android: 'troubleshoot', web: 'troubleshoot' }}
                  label="Diagnostics"
                  value="Runtime status"
                />
                <View style={styles.diagnosticsAction}>
                  <PressableRow onPress={() => router.push('/diagnostics')} />
                </View>
              </View>
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
      />
    </View>
  );
}

function PressableRow({ onPress }: { onPress: () => void }) {
  return (
    <AppButton label="Open diagnostics" variant="secondary" onPress={onPress} />
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

function SettingRow({ icon, label, value }: SettingRowProps) {
  const theme = useTheme();

  return (
    <View style={styles.row}>
      <View style={[styles.iconFrame, { backgroundColor: theme.accentSoft }]}>
        <AppIcon name={icon} size={20} tintColor={theme.accent} fallback="•" />
      </View>
      <ThemedText type="small" style={styles.rowLabel}>
        {label}
      </ThemedText>
      <ThemedText type="small" themeColor="textMuted" numberOfLines={1}>
        {value}
      </ThemedText>
    </View>
  );
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
    minHeight: 60,
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
  diagnosticsAction: {
    paddingHorizontal: Spacing.two,
    paddingBottom: Spacing.two,
  },
});
