import Constants from 'expo-constants';
import { router } from 'expo-router';
import { Linking, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { AppIcon } from '@/components/ui/app-icon';
import { GlassSurface } from '@/components/ui/glass-surface';
import { Screen } from '@/components/ui/screen';
import { ScrollEdgeFrame } from '@/components/ui/scroll-edge-frame';
import { ThemedText } from '@/components/themed-text';
import { ControlHeight, Radius, Spacing } from '@/constants/theme';
import {
  useDockContentInset,
  useDockScrollHandler,
} from '@/features/navigation/floating-dock';
import { useAppSettings } from '@/hooks/use-app-settings';
import { useTheme } from '@/hooks/use-theme';

const REPO_URL = 'https://github.com/ljxw88/remodr-client';
const RELEASES_URL = `${REPO_URL}/releases`;

type IconSpec = {
  ios: string;
  android: string;
  web: string;
};

type SettingRowProps = {
  icon: IconSpec;
  label: string;
  value?: string;
  description?: string;
  onPress?: () => void;
  external?: boolean;
};

export default function SettingsScreen() {
  const version = Constants.expoConfig?.version ?? '0.1.0';
  const buildNumber =
    Constants.expoConfig?.android?.versionCode ??
    Constants.expoConfig?.ios?.buildNumber;
  const versionDisplay = buildNumber ? `v${version} (${buildNumber})` : `v${version}`;
  const onDockScroll = useDockScrollHandler();
  const dockContentInset = useDockContentInset();
  const {
    marqueeEnabled,
    setMarqueeEnabled,
    agentFiltersExpanded,
    setAgentFiltersExpanded,
  } = useAppSettings();

  const openUrl = (url: string) => {
    void Linking.openURL(url).catch((err) => {
      console.warn('[SETTINGS] Could not open URL:', err);
    });
  };

  return (
    <Screen includeTopSafeArea>
      <ScrollEdgeFrame onScroll={onDockScroll}>
        {(edge) => (
          <ScrollView
            {...edge}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={[styles.content, { paddingBottom: dockContentInset }]}>
            <HeroCard version={version} buildNumber={buildNumber} />

            <SettingsGroup title="Security & Credentials">
              <SettingRow
                icon={{ ios: 'key', android: 'key', web: 'key' }}
                label="Credentials"
                value="Android Keystore"
                description="Hardware-backed key storage"
              />
              <SettingDivider />
              <SettingRow
                icon={{ ios: 'checkmark.shield', android: 'security', web: 'security' }}
                label="Host keys"
                value="Strict verification"
                description="Rejects unknown server certificates"
              />
              <SettingDivider />
              <SettingRow
                icon={{ ios: 'network', android: 'lan', web: 'lan' }}
                label="SSH bridge"
                value="Encrypted tunnel"
                description="Secure authenticated socket protocol"
              />
            </SettingsGroup>

            <SettingsGroup title="Interface & Display">
              <SettingSwitchRow
                icon={{ ios: 'arrow.left.and.right', android: 'swap_horiz', web: 'swap_horiz' }}
                label="Marquee animation"
                description="Scroll overflowing names smoothly"
                value={marqueeEnabled}
                onValueChange={(enabled) => void setMarqueeEnabled(enabled)}
              />
              <SettingDivider />
              <SettingSwitchRow
                icon={{ ios: 'line.3.horizontal.decrease.circle', android: 'filter_list', web: 'filter_list' }}
                label="Workspace filters"
                description="Show server and space chips by default"
                value={agentFiltersExpanded}
                onValueChange={(expanded) => void setAgentFiltersExpanded(expanded)}
              />
              <SettingDivider />
              <SettingRow
                icon={{ ios: 'moon.stars', android: 'dark_mode', web: 'dark_mode' }}
                label="Theme"
                value="Always dark"
                description="OLED near-black canvas"
              />
            </SettingsGroup>

            <SettingsGroup title="Diagnostics & System">
              <SettingRow
                icon={{ ios: 'stethoscope', android: 'troubleshoot', web: 'troubleshoot' }}
                label="Runtime diagnostics"
                description="Inspect connection events, bridge & sessions"
                onPress={() => router.push('/diagnostics')}
              />
            </SettingsGroup>

            <SettingsGroup title="About & Releases">
              <SettingRow
                icon={{ ios: 'info.circle', android: 'info', web: 'info' }}
                label="Version"
                value={versionDisplay}
                description="Alpha test channel"
              />
              <SettingDivider />
              <SettingRow
                icon={{ ios: 'sparkles', android: 'auto_awesome', web: 'auto_awesome' }}
                label="Release channel"
                value="Alpha preview"
              />
              <SettingDivider />
              <SettingRow
                icon={{ ios: 'arrow.up.right.square', android: 'open_in_new', web: 'open_in_new' }}
                label="GitHub releases"
                value="View updates"
                description="Download latest APK and changelog"
                onPress={() => openUrl(RELEASES_URL)}
                external
              />
              <SettingDivider />
              <SettingRow
                icon={{ ios: 'chevron.left.forwardslash.chevron.right', android: 'code', web: 'code' }}
                label="Source repository"
                value="ljxw88/remodr-client"
                onPress={() => openUrl(REPO_URL)}
                external
              />
              <SettingDivider />
              <SettingRow
                icon={{ ios: 'doc.text', android: 'description', web: 'description' }}
                label="License"
                value="MIT"
              />
            </SettingsGroup>

            <View style={styles.footer}>
              <ThemedText type="caption" themeColor="textMuted" style={styles.footerText}>
                Remodr Alpha • Crafted for remote autonomous agents
              </ThemedText>
            </View>
          </ScrollView>
        )}
      </ScrollEdgeFrame>
    </Screen>
  );
}

function HeroCard({ version, buildNumber }: { version: string; buildNumber?: number | string }) {
  const theme = useTheme();

  return (
    <GlassSurface strength="strong" style={styles.heroCard}>
      <View style={styles.heroContent}>
        <View style={[styles.heroIconFrame, { backgroundColor: theme.accentSoft }]}>
          <AppIcon
            name={{ ios: 'terminal', android: 'terminal', web: 'terminal' }}
            size={28}
            tintColor={theme.accent}
            fallback="⚡"
          />
        </View>
        <View style={styles.heroDetails}>
          <ThemedText type="heading" style={styles.heroTitle}>
            Remodr
          </ThemedText>
          <ThemedText type="small" themeColor="textMuted" style={styles.heroSubtitle}>
            Remote Workspace Agent Client
          </ThemedText>
        </View>
      </View>

      <View style={styles.heroBadges}>
        <View style={[styles.badge, styles.badgeAccent, { backgroundColor: theme.accentSoft }]}>
          <ThemedText type="label" style={{ color: theme.accent }}>
            ALPHA
          </ThemedText>
        </View>
        <View style={[styles.badge, { backgroundColor: theme.backgroundElement }]}>
          <ThemedText type="label" themeColor="textSecondary">
            v{version}
          </ThemedText>
        </View>
        {buildNumber ? (
          <View style={[styles.badge, { backgroundColor: theme.backgroundElement }]}>
            <ThemedText type="label" themeColor="textMuted">
              Build {buildNumber}
            </ThemedText>
          </View>
        ) : null}
      </View>
    </GlassSurface>
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

function SettingRow({ icon, label, value, description, onPress, external }: SettingRowProps) {
  const theme = useTheme();

  const content = (
    <View style={styles.row}>
      <View style={[styles.iconFrame, { backgroundColor: theme.accentSoft }]}>
        <AppIcon name={icon as any} size={20} tintColor={theme.accent} fallback="•" />
      </View>
      <View style={styles.rowLabelContainer}>
        <ThemedText type="small" style={styles.rowLabel}>
          {label}
        </ThemedText>
        {description ? (
          <ThemedText type="caption" themeColor="textMuted" numberOfLines={1}>
            {description}
          </ThemedText>
        ) : null}
      </View>
      {value ? (
        <ThemedText type="small" themeColor="textMuted" numberOfLines={1} style={styles.rowValue}>
          {value}
        </ThemedText>
      ) : null}
      {onPress ? (
        <View style={styles.chevron}>
          <AppIcon
            name={
              external
                ? ({ ios: 'arrow.up.right', android: 'north_east', web: 'north_east' } as any)
                : ({ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' } as any)
            }
            size={16}
            tintColor={theme.textMuted}
            fallback={external ? '↗' : '›'}
          />
        </View>
      ) : null}
    </View>
  );

  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}${value ? `, ${value}` : ''}`}
        accessibilityHint={description}
        onPress={onPress}
        style={({ pressed }) => [
          styles.pressableRow,
          { backgroundColor: pressed ? theme.backgroundSelected : 'transparent' },
        ]}>
        {content}
      </Pressable>
    );
  }

  return content;
}

function SettingSwitchRow({
  icon,
  label,
  description,
  value,
  onValueChange,
}: {
  icon: IconSpec;
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (val: boolean) => void;
}) {
  const theme = useTheme();

  return (
    <View style={styles.row}>
      <View style={[styles.iconFrame, { backgroundColor: theme.accentSoft }]}>
        <AppIcon name={icon as any} size={20} tintColor={theme.accent} fallback="↔" />
      </View>
      <View style={styles.rowLabelContainer}>
        <ThemedText type="small" style={styles.rowLabel}>
          {label}
        </ThemedText>
        {description ? (
          <ThemedText type="caption" themeColor="textMuted" numberOfLines={1}>
            {description}
          </ThemedText>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: theme.border, true: theme.accent }}
      />
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
  heroCard: {
    padding: Spacing.two,
    borderRadius: Radius.glass,
    gap: Spacing.two,
  },
  heroContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  heroIconFrame: {
    width: 48,
    height: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.control,
  },
  heroDetails: {
    flex: 1,
    gap: 2,
  },
  heroTitle: {
    fontSize: 22,
    lineHeight: 26,
  },
  heroSubtitle: {
    letterSpacing: -0.1,
  },
  heroBadges: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingTop: Spacing.half,
  },
  badge: {
    paddingHorizontal: Spacing.one,
    paddingVertical: 3,
    borderRadius: Radius.tag,
  },
  badgeAccent: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(102,130,240,0.35)',
  },
  group: {
    gap: Spacing.one,
  },
  groupTitle: {
    letterSpacing: 0.7,
    paddingHorizontal: Spacing.half,
  },
  card: {
    borderRadius: Radius.glass,
    overflow: 'hidden',
  },
  pressableRow: {
    borderRadius: Radius.glass,
  },
  row: {
    minHeight: ControlHeight.row,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
  },
  iconFrame: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 12,
  },
  rowLabelContainer: {
    flex: 1,
    gap: 1,
  },
  rowLabel: {
    letterSpacing: -0.1,
  },
  rowValue: {
    maxWidth: '40%',
  },
  chevron: {
    marginLeft: Spacing.half,
    opacity: 0.7,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 68,
  },
  footer: {
    alignItems: 'center',
    paddingVertical: Spacing.two,
  },
  footerText: {
    letterSpacing: 0.2,
  },
});

