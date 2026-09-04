import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { AppIcon, type AppIconName } from '@/components/ui/app-icon';
import { SheetModal, SheetPanel } from '@/components/ui/sheet';
import { ThemedText } from '@/components/themed-text';
import { ControlHeight, Fonts, Radius, Spacing } from '@/constants/theme';
import { useSubscription } from '@/features/subscription/use-subscription';
import { useDockContentInset } from '@/features/navigation/floating-dock';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  visible: boolean;
  onClose: () => void;
};

export function UpgradeSheet({ visible, onClose }: Props) {
  const theme = useTheme();
  const dockContentInset = useDockContentInset();
  const { isPro, upgradeToPro, downgradeToFree, restorePurchases } = useSubscription();
  const [selectedPlan, setSelectedPlan] = useState<'monthly' | 'lifetime'>('monthly');
  const [loading, setLoading] = useState(false);

  async function handleUpgrade() {
    if (!__DEV__) {
      Alert.alert(
        'Purchases unavailable',
        'Store purchases are not configured in this build.',
      );
      return;
    }
    setLoading(true);
    try {
      await upgradeToPro();
      Alert.alert('Development override applied', 'Pro features are enabled for testing.', [
        { text: 'OK', onPress: onClose },
      ]);
    } catch {
      Alert.alert('Upgrade Failed', 'Could not complete the purchase. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleRestore() {
    setLoading(true);
    try {
      const restored = await restorePurchases();
      if (restored) {
        Alert.alert('Purchases Restored', 'Your Pro subscription has been restored.', [
          { text: 'OK', onPress: onClose },
        ]);
      } else {
        Alert.alert('No Subscription Found', 'No prior Pro purchases were found for this account.');
      }
    } catch {
      Alert.alert('Restore Failed', 'Unable to reach the store. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <SheetModal
      closeLabel="Close upgrade sheet"
      onClose={onClose}
      busy={loading}
      visible={visible}>
      {(close) => (
      <SheetPanel style={styles.sheet}>
        <ScrollView
            contentContainerStyle={[
              styles.sheetContent,
              { paddingBottom: dockContentInset + Spacing.two },
            ]}
            showsVerticalScrollIndicator={false}>
            <View style={styles.header}>
              <View style={[styles.crownFrame, { backgroundColor: theme.accentSoft }]}>
              <AppIcon
                name={{ ios: 'sparkles', android: 'auto_awesome', web: 'auto_awesome' }}
                size={26}
                tintColor={theme.accent}
                fallback="★"
              />
            </View>
            <ThemedText type="heading" style={styles.title}>
              Upgrade to Remote Pro
            </ThemedText>
            <ThemedText type="caption" themeColor="textSecondary" style={styles.subtitle}>
              {__DEV__
                ? 'Preview unlimited remote devices and concurrent agents.'
                : 'Store purchases are not configured in this build.'}
            </ThemedText>
          </View>

          <View style={[styles.featuresCard, { backgroundColor: theme.backgroundElement, borderColor: theme.border }]}>
            <FeatureRow
              icon={{ ios: 'desktopcomputer', android: 'computer', web: 'computer' }}
              title="Unlimited Remote Devices"
              description="Manage and bridge to all your servers, VMs, containers, and hosts."
            />
            <View style={[styles.featureDivider, { backgroundColor: theme.border }]} />
            <FeatureRow
              icon={{ ios: 'bolt.fill', android: 'bolt', web: 'bolt' }}
              title="Priority Background Sync"
              description="Real-time multi-agent bridging and active workspace monitoring."
            />
            <View style={[styles.featureDivider, { backgroundColor: theme.border }]} />
            <FeatureRow
              icon={{ ios: 'key.fill', android: 'key', web: 'key' }}
              title="Hardware Keystore Security"
              description="Encrypted SSH credentials and strict host key verification."
            />
          </View>

          <View style={styles.planOptions}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: selectedPlan === 'monthly' }}
              onPress={() => setSelectedPlan('monthly')}
              style={({ pressed }) => [
                styles.planCard,
                {
                  backgroundColor:
                    selectedPlan === 'monthly' ? theme.accentSoft : theme.backgroundElement,
                  borderColor: selectedPlan === 'monthly' ? theme.accent : theme.border,
                  opacity: pressed ? 0.75 : 1,
                },
              ]}>
              <View style={styles.planCopy}>
                <ThemedText type="smallBold">Monthly Pro</ThemedText>
                <ThemedText type="caption" themeColor="textSecondary">
                  Flexible recurring plan
                </ThemedText>
              </View>
              <View style={styles.planPrice}>
                <ThemedText type="section" style={{ color: selectedPlan === 'monthly' ? theme.accent : theme.text }}>
                  $4.99
                </ThemedText>
                <ThemedText type="caption" themeColor="textMuted">
                  /month
                </ThemedText>
              </View>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: selectedPlan === 'lifetime' }}
              onPress={() => setSelectedPlan('lifetime')}
              style={({ pressed }) => [
                styles.planCard,
                {
                  backgroundColor:
                    selectedPlan === 'lifetime' ? theme.accentSoft : theme.backgroundElement,
                  borderColor: selectedPlan === 'lifetime' ? theme.accent : theme.border,
                  opacity: pressed ? 0.75 : 1,
                },
              ]}>
              <View style={styles.planCopy}>
                <View style={styles.badgeRow}>
                  <ThemedText type="smallBold">Lifetime Access</ThemedText>
                  <View style={[styles.badge, { backgroundColor: theme.accent }]}>
                    <ThemedText type="caption" style={styles.badgeText}>
                      BEST VALUE
                    </ThemedText>
                  </View>
                </View>
                <ThemedText type="caption" themeColor="textSecondary">
                  Pay once, own forever
                </ThemedText>
              </View>
              <View style={styles.planPrice}>
                <ThemedText type="section" style={{ color: selectedPlan === 'lifetime' ? theme.accent : theme.text }}>
                  $29.99
                </ThemedText>
                <ThemedText type="caption" themeColor="textMuted">
                  one-time
                </ThemedText>
              </View>
            </Pressable>
          </View>

          <AppButton
            label={
              loading
                ? 'Processing…'
                : isPro
                  ? 'Development Pro Active'
                  : __DEV__
                    ? `Preview ${selectedPlan === 'monthly' ? 'Monthly' : 'Lifetime'} Pro`
                    : 'Purchases unavailable'
            }
            disabled={loading || isPro || !__DEV__}
            onPress={() => void handleUpgrade()}
          />

          {__DEV__ ? (
            <View style={styles.secondaryActions}>
            <Pressable
              accessibilityRole="button"
              disabled={loading}
              onPress={() => void handleRestore()}
              style={styles.restoreButton}>
              <ThemedText type="caption" themeColor="textSecondary">
                Restore purchases
              </ThemedText>
            </Pressable>

            {isPro ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  void downgradeToFree();
                  Alert.alert('Reset to Free Trial', 'Plan reset to free trial limits.');
                }}>
                <ThemedText type="caption" themeColor="textMuted">
                  Switch to Free tier (dev test)
                </ThemedText>
              </Pressable>
            ) : null}
            </View>
          ) : null}
        </ScrollView>

        {/* After the ScrollView so it stays above the content, and absolute so
            the centred header keeps its symmetry. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          disabled={loading}
          hitSlop={8}
          onPress={close}
          style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
          <AppIcon
            name={{ ios: 'xmark', android: 'close', web: 'close' }}
            size={20}
            tintColor={theme.textSecondary}
            fallback="×"
          />
        </Pressable>
      </SheetPanel>
      )}
    </SheetModal>
  );
}

function FeatureRow({
  icon,
  title,
  description,
}: {
  icon: AppIconName;
  title: string;
  description: string;
}) {
  const theme = useTheme();
  return (
    <View style={styles.featureRow}>
      <View style={[styles.featureIconFrame, { backgroundColor: theme.accentSoft }]}>
        <AppIcon name={icon} size={18} tintColor={theme.accent} fallback="•" />
      </View>
      <View style={styles.featureCopy}>
        <ThemedText type="smallBold">{title}</ThemedText>
        <ThemedText type="caption" themeColor="textSecondary">
          {description}
        </ThemedText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    maxHeight: '94%',
  },
  sheetContent: {
    gap: Spacing.two + Spacing.half,
  },
  header: {
    alignItems: 'center',
    gap: Spacing.half,
    paddingTop: Spacing.one,
  },
  close: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: ControlHeight.regular,
    height: ControlHeight.regular,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.pill,
  },
  pressed: {
    opacity: 0.6,
  },
  crownFrame: {
    width: 52,
    height: 52,
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: Spacing.half,
  },
  title: {
    textAlign: 'center',
  },
  subtitle: {
    textAlign: 'center',
    paddingHorizontal: Spacing.two,
  },
  featuresCard: {
    borderRadius: Radius.control,
    borderWidth: 1,
    padding: Spacing.two,
    gap: Spacing.one + Spacing.half,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + Spacing.half,
  },
  featureIconFrame: {
    width: ControlHeight.compact,
    height: ControlHeight.compact,
    borderRadius: Radius.tag,
    alignItems: 'center',
    justifyContent: 'center',
  },
  featureCopy: {
    flex: 1,
    gap: 2,
  },
  featureDivider: {
    height: StyleSheet.hairlineWidth,
    // Starts where the copy starts, past the icon and the gap after it.
    marginLeft: ControlHeight.compact + Spacing.one + Spacing.half,
  },
  planOptions: {
    gap: Spacing.one,
  },
  planCard: {
    minHeight: ControlHeight.row,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.half,
    borderRadius: Radius.control,
    borderWidth: 1.5,
  },
  planCopy: {
    gap: 2,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
  },
  badge: {
    paddingHorizontal: Spacing.one,
    paddingVertical: 2,
    borderRadius: Radius.pill,
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontFamily: Fonts.semibold,
    fontWeight: 700,
  },
  planPrice: {
    alignItems: 'flex-end',
  },
  secondaryActions: {
    alignItems: 'center',
    gap: Spacing.one,
    paddingTop: Spacing.half,
  },
  restoreButton: {
    paddingVertical: Spacing.half,
  },
});
