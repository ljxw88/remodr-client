import { ErrorCode, useIAP } from 'expo-iap';
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AppButton } from '@/components/ui/app-button';
import { AppIcon } from '@/components/ui/app-icon';
import { GlassSurface } from '@/components/ui/glass-surface';
import { Screen } from '@/components/ui/screen';
import { ThemedText } from '@/components/themed-text';
import { ControlHeight, Radius, Spacing } from '@/constants/theme';
import { REWARD_PRODUCTS, type RewardProductId } from '@/features/rewards/reward-products';
import { useTheme } from '@/hooks/use-theme';

export default function SupportScreen() {
  const theme = useTheme();
  const [selectedId, setSelectedId] = useState<RewardProductId | null>(null);
  const [isFinishing, setIsFinishing] = useState(false);
  const {
    connected,
    products,
    fetchProducts,
    requestPurchase,
    finishTransaction,
  } = useIAP({
    onPurchaseSuccess: async (purchase) => {
      setIsFinishing(true);
      try {
        await finishTransaction({ purchase, isConsumable: true });
        Alert.alert('Thank you', 'Your support has been received.');
      } catch (error) {
        Alert.alert('Could not complete payment', toErrorMessage(error));
      } finally {
        setIsFinishing(false);
        setSelectedId(null);
      }
    },
    onPurchaseError: (error) => {
      setSelectedId(null);
      if (error.code !== ErrorCode.UserCancelled) {
        Alert.alert('Payment unavailable', toPurchaseErrorMessage(error));
      }
    },
    onError: (error) => {
      Alert.alert('Payment unavailable', toErrorMessage(error));
    },
  });

  useEffect(() => {
    if (connected) {
      void fetchProducts({ skus: REWARD_PRODUCTS.map((product) => product.id), type: 'in-app' });
    }
  }, [connected, fetchProducts]);

  const productsById = useMemo(
    () => new Map(products.map((product) => [product.id, product])),
    [products],
  );

  const buy = async (id: RewardProductId) => {
    setSelectedId(id);
    try {
      await requestPurchase({
        type: 'in-app',
        request: {
          apple: { sku: id },
          google: { skus: [id] },
        },
      });
    } catch (error) {
      setSelectedId(null);
      Alert.alert('Payment unavailable', toErrorMessage(error));
    }
  };

  return (
    <Screen includeTopSafeArea>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          style={({ pressed }) => [styles.back, { opacity: pressed ? 0.7 : 1 }]}>
          <AppIcon
            name={{ ios: 'chevron.left', android: 'arrow_back', web: 'arrow_back' }}
            size={20}
            tintColor={theme.text}
            fallback="<"
          />
          <ThemedText type="small">Settings</ThemedText>
        </Pressable>

        <View style={styles.heading}>
          <View style={[styles.heroIcon, { backgroundColor: theme.accentSoft }]}>
            <AppIcon
              name={{ ios: 'heart.fill', android: 'favorite', web: 'favorite' }}
              size={28}
              tintColor={theme.accent}
              fallback="♥"
            />
          </View>
          <ThemedText type="heading">Support Remodr</ThemedText>
          <ThemedText themeColor="textSecondary" style={styles.description}>
            If Remodr is useful to you, you can leave a tip. Payments are handled securely by
            the App Store or Google Play.
          </ThemedText>
        </View>

        <GlassSurface strength="strong" style={styles.card}>
          {REWARD_PRODUCTS.map((reward, index) => {
            const product = productsById.get(reward.id);
            const busy = selectedId === reward.id || isFinishing;
            return (
              <View key={reward.id}>
                {index > 0 ? <View style={[styles.divider, { backgroundColor: theme.border }]} /> : null}
                <View style={styles.rewardRow}>
                  <View style={styles.rewardCopy}>
                    <ThemedText type="smallBold">{reward.label}</ThemedText>
                    <ThemedText type="caption" themeColor="textMuted">
                      One-time purchase
                    </ThemedText>
                  </View>
                  <AppButton
                    label={product?.displayPrice ?? reward.fallbackPrice}
                    onPress={() => void buy(reward.id)}
                    disabled={!connected || !product || busy}
                  />
                </View>
              </View>
            );
          })}
        </GlassSurface>

        <ThemedText type="caption" themeColor="textMuted" style={styles.note}>
          This is a one-time consumable purchase. It does not unlock or change any app features.
        </ThemedText>
      </ScrollView>
    </Screen>
  );
}

function toPurchaseErrorMessage(error: { message?: string }): string {
  return error.message || 'Please try again later.';
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Please try again later.';
}

const styles = StyleSheet.create({
  content: {
    gap: Spacing.three,
    paddingBottom: Spacing.four,
  },
  back: {
    minHeight: ControlHeight.compact,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: Spacing.half,
  },
  heading: {
    alignItems: 'center',
    gap: Spacing.one,
    paddingVertical: Spacing.two,
  },
  heroIcon: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.glass,
    marginBottom: Spacing.one,
  },
  description: {
    maxWidth: 420,
    textAlign: 'center',
    lineHeight: 22,
  },
  card: {
    padding: Spacing.one,
  },
  rewardRow: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.one,
  },
  rewardCopy: {
    flex: 1,
    gap: Spacing.half,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginHorizontal: Spacing.one,
  },
  note: {
    textAlign: 'center',
    paddingHorizontal: Spacing.two,
  },
});
