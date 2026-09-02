import Constants from 'expo-constants';
import { router } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { AppButton } from '@/components/ui/app-button';
import { Screen } from '@/components/ui/screen';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type SettingRowProps = {
  icon: {
    ios:
      | 'key'
      | 'checkmark.shield'
      | 'info.circle'
      | 'stethoscope';
    android: 'key' | 'security' | 'info' | 'troubleshoot';
    web: 'key' | 'security' | 'info' | 'troubleshoot';
  };
  label: string;
  value: string;
};

export default function SettingsScreen() {
  const version = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <Screen includeTopSafeArea>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}>
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
    </Screen>
  );
}

function PressableRow({ onPress }: { onPress: () => void }) {
  return (
    <AppButton label="Open diagnostics" variant="secondary" onPress={onPress} />
  );
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={styles.group}>
      <ThemedText type="label" themeColor="textMuted" style={styles.groupTitle}>
        {title.toUpperCase()}
      </ThemedText>
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.backgroundElement,
            borderColor: theme.border,
            shadowColor: theme.glassShadow,
          },
        ]}>
        {children}
      </View>
    </View>
  );
}

function SettingRow({ icon, label, value }: SettingRowProps) {
  const theme = useTheme();

  return (
    <View style={styles.row}>
      <View style={[styles.iconFrame, { backgroundColor: theme.accentSoft }]}>
        <AppIcon name={icon} size={20} tintColor={theme.text} fallback="•" />
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
    paddingBottom: Spacing.four,
  },
  group: {
    gap: Spacing.one,
  },
  groupTitle: {
    letterSpacing: 0.7,
    paddingHorizontal: Spacing.half,
  },
  card: {
    borderWidth: 1,
    borderRadius: 22,
    overflow: 'hidden',
    elevation: 2,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 1,
    shadowRadius: 16,
  },
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
