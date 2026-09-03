import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppIcon, type AppIconName } from '@/components/ui/app-icon';
import { ThemedText } from '@/components/themed-text';
import { Radius, Spacing } from '@/constants/theme';
import { useSubscription } from '@/features/subscription/use-subscription';
import { UpgradeSheet } from '@/features/subscription/upgrade-sheet';
import { useTheme } from '@/hooks/use-theme';

export function PlanCard() {
  const theme = useTheme();
  const {
    isPro,
    deviceQuota,
    agentQuota,
    upgradeToPro,
    downgradeToFree,
  } = useSubscription();
  const [showUpgradeSheet, setShowUpgradeSheet] = useState(false);

  const deviceRatio = isPro ? 0 : Math.min(1, deviceQuota.used / deviceQuota.limit);

  return (
    <>
      <View
        style={[
          styles.card,
          {
            backgroundColor: theme.glassStrong,
            borderColor: isPro ? theme.accent : theme.glassBorder,
            shadowColor: isPro ? theme.accentSoft : theme.glassShadow,
          },
        ]}>
        <View style={styles.header}>
          <View style={styles.planInfo}>
            <View style={styles.badgeRow}>
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: isPro ? theme.accent : theme.warning },
                ]}
              />
              <ThemedText type="smallBold" style={styles.planTitle}>
                {isPro ? 'Pro Membership' : 'Free Trial'}
              </ThemedText>
            </View>
            <ThemedText type="caption" themeColor="textSecondary">
              {isPro
                ? 'Unlimited remote devices & agent sessions'
                : 'Free tier: 1 remote device · Unlimited agent sessions'}
            </ThemedText>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={isPro ? 'Pro Plan Active' : 'Upgrade to Pro'}
            onPress={() => setShowUpgradeSheet(true)}
            style={({ pressed }) => [
              styles.upgradeBtn,
              {
                backgroundColor: isPro ? theme.accentSoft : theme.accent,
                opacity: pressed ? 0.75 : 1,
              },
            ]}>
            <AppIcon
              name={{ ios: 'sparkles', android: 'auto_awesome', web: 'auto_awesome' }}
              size={14}
              tintColor={isPro ? theme.accent : theme.onAccent}
              fallback="★"
            />
            <ThemedText
              type="caption"
              style={{
                color: isPro ? theme.accent : theme.onAccent,
                fontWeight: 600,
              }}>
              {isPro ? 'Manage' : 'Upgrade'}
            </ThemedText>
          </Pressable>
        </View>

        <View style={[styles.divider, { backgroundColor: theme.border }]} />

        <View style={styles.quotas}>
          <QuotaRow
            label="Remote Devices"
            value={deviceQuota.label}
            ratio={deviceRatio}
            isLimitReached={deviceQuota.isLimitReached}
            icon={{ ios: 'desktopcomputer', android: 'computer', web: 'computer' }}
          />
          <QuotaRow
            label="Agent Sessions"
            value={agentQuota.label}
            ratio={0}
            isLimitReached={false}
            icon={{ ios: 'bubble.left.and.bubble.right', android: 'smart_toy', web: 'smart_toy' }}
          />
        </View>

        {__DEV__ ? (
          <View style={[styles.testRow, { backgroundColor: theme.backgroundElement }]}>
            <ThemedText type="caption" themeColor="textMuted">
              Development tier:
            </ThemedText>
            {isPro ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => void downgradeToFree()}
                style={({ pressed }) => [
                  styles.tierSwitchBtn,
                  { borderColor: theme.warning, opacity: pressed ? 0.7 : 1 },
                ]}>
                <ThemedText type="caption" style={{ color: theme.warning, fontWeight: 600 }}>
                  Use Free
                </ThemedText>
              </Pressable>
            ) : (
              <Pressable
                accessibilityRole="button"
                onPress={() => void upgradeToPro()}
                style={({ pressed }) => [
                  styles.tierSwitchBtn,
                  { borderColor: theme.accent, opacity: pressed ? 0.7 : 1 },
                ]}>
                <ThemedText type="caption" style={{ color: theme.accent, fontWeight: 600 }}>
                  Preview Pro
                </ThemedText>
              </Pressable>
            )}
          </View>
        ) : null}
      </View>

      <UpgradeSheet
        visible={showUpgradeSheet}
        onClose={() => setShowUpgradeSheet(false)}
      />
    </>
  );
}

function QuotaRow({
  label,
  value,
  ratio,
  isLimitReached,
  icon,
}: {
  label: string;
  value: string;
  ratio: number;
  isLimitReached: boolean;
  icon: AppIconName;
}) {
  const theme = useTheme();
  const barColor = isLimitReached ? theme.danger : ratio > 0.7 ? theme.warning : theme.accent;

  return (
    <View style={styles.quotaRow}>
      <View style={styles.quotaHeader}>
        <View style={styles.quotaLabelGroup}>
          <AppIcon name={icon} size={15} tintColor={theme.textSecondary} fallback="•" />
          <ThemedText type="caption" themeColor="textSecondary">
            {label}
          </ThemedText>
        </View>
        <ThemedText
          type="caption"
          style={{
            color: isLimitReached ? theme.danger : theme.text,
            fontWeight: 600,
          }}>
          {value}
        </ThemedText>
      </View>

      <View style={[styles.progressTrack, { backgroundColor: theme.backgroundElement }]}>
        <View
          style={[
            styles.progressFill,
            {
              backgroundColor: barColor,
              width: `${Math.max(4, Math.round(ratio * 100))}%`,
            },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: Radius.control,
    padding: Spacing.two,
    gap: Spacing.one + Spacing.half,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  planInfo: {
    flex: 1,
    gap: Spacing.half,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: Radius.pill,
  },
  planTitle: {
    letterSpacing: -0.2,
  },
  upgradeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.half,
    paddingHorizontal: Spacing.one + Spacing.half,
    paddingVertical: Spacing.one,
    borderRadius: Radius.pill,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  quotas: {
    gap: Spacing.one + Spacing.half,
  },
  testRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.one + Spacing.half,
    paddingVertical: Spacing.one,
    borderRadius: Radius.control,
    marginTop: Spacing.half,
  },
  tierSwitchBtn: {
    paddingHorizontal: Spacing.one + Spacing.half,
    paddingVertical: Spacing.half,
    borderRadius: Radius.pill,
    borderWidth: 1,
  },
  quotaRow: {
    gap: Spacing.half,
  },
  quotaHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  quotaLabelGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  progressTrack: {
    height: 6,
    borderRadius: Radius.pill,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: Radius.pill,
  },
});
