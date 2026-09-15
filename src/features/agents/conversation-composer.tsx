import type { ReactNode } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { AppIcon } from '@/components/ui/app-icon';
import { GlassSurface } from '@/components/ui/glass-surface';
import { SkeletonBlock, SkeletonGroup, SkeletonLine } from '@/components/ui/skeleton';
import { Colors, Fonts, Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';

type Props = {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  sending: boolean;
  answerPending: boolean;
  error: string | null;
  hasOpenRequest: boolean;
  requestUsesForm?: boolean;
  requestBar?: ReactNode;
  onHeightChange: (height: number) => void;
  modelName: string;
  tunable: boolean;
  onOpenModelSettings: () => void;
  keyboardOffset?: number;
  showLatest: boolean;
  onFollowLatest: () => void;
};

const MIN_INPUT_HEIGHT = 38;
const MAX_INPUT_HEIGHT = 120;

export function ConversationComposerSkeleton() {
  return (
    <SkeletonGroup label="Loading message controls" style={[styles.composer, { position: 'relative' }]}>
      <View style={styles.cardWrapper}>
        <GlassSurface strength="strong" style={styles.cardSurface}>
          <View style={styles.cardContent}>
            <View style={styles.cardTop}>
              <SkeletonBlock width={styles.atButton.width} height={styles.atButton.height} radius={styles.atButton.borderRadius} />
            </View>
            <View style={{ minHeight: MIN_INPUT_HEIGHT, justifyContent: 'center' }}>
              <SkeletonLine width="62%" lineHeight={20} />
            </View>
            <View style={styles.cardBottom}>
              <View style={styles.pill}><SkeletonLine width={100} lineHeight={20} /></View>
              <SkeletonBlock width={styles.send.width} height={styles.send.height} radius={styles.send.borderRadius} />
            </View>
          </View>
        </GlassSurface>
      </View>
    </SkeletonGroup>
  );
}

export function ConversationComposer({
  value,
  onChangeText,
  onSend,
  sending,
  answerPending,
  error,
  hasOpenRequest,
  requestUsesForm = false,
  requestBar,
  onHeightChange,
  modelName,
  tunable,
  onOpenModelSettings,
  keyboardOffset = 0,
  showLatest,
  onFollowLatest,
}: Props) {
  const theme = useTheme();

  return (
    <View
      style={[styles.composer, { bottom: keyboardOffset }]}
      onLayout={(event) => onHeightChange(event.nativeEvent.layout.height)}>
      {/* Last before the card: the request bar tucks itself underneath it. */}
      {requestBar}
      <View style={styles.cardWrapper}>
        <GlassSurface
          tone="chrome"
          strength="strong"
          highlight
          style={styles.cardSurface}>
          <View style={styles.cardContent}>
            <View style={styles.cardTop}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add context"
                onPress={() => {
                  onChangeText(value ? (value.endsWith(' ') ? `${value}@` : `${value} @`) : '@');
                }}
                style={({ pressed }) => [
                  styles.atButton,
                  {
                    backgroundColor: pressed ? 'rgba(255, 255, 255, 0.12)' : 'rgba(255, 255, 255, 0.06)',
                    borderColor: theme.glassBorder,
                  },
                ]}>
                <ThemedText style={styles.atText}>@</ThemedText>
              </Pressable>
              {showLatest ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Scroll to latest message"
                  accessibilityHint="Resume following new messages"
                  hitSlop={8}
                  onPress={onFollowLatest}
                  style={({ pressed }) => [
                    styles.latest,
                    { backgroundColor: theme.accentSoft, opacity: pressed ? 0.72 : 1 },
                  ]}>
                  <AppIcon
                    name={{ ios: 'arrow.down', android: 'arrow_downward', web: 'arrow_downward' }}
                    size={14}
                    tintColor={theme.text}
                    fallback="↓"
                  />
                  <ThemedText type="caption">Latest</ThemedText>
                </Pressable>
              ) : null}
            </View>

            <TextInput
              accessibilityLabel={
                requestUsesForm
                  ? 'Complete the questions above'
                  : hasOpenRequest ? 'Write an answer' : 'Build anything'
              }
              multiline
              blurOnSubmit={false}
              editable={!requestUsesForm}
              textAlignVertical="top"
              maxLength={20_000}
              value={value}
              onChangeText={onChangeText}
              placeholder={
                answerPending
                  ? 'Answer queued…'
                  : requestUsesForm
                    ? 'Complete the questions above…'
                    : hasOpenRequest ? 'Write another answer…' : 'Build anything…'
              }
              placeholderTextColor={theme.placeholder}
              style={[styles.input, { color: theme.text }]}
            />
            {error ? (
              <ThemedText type="caption" themeColor="danger" accessibilityLiveRegion="polite">
                {error}
              </ThemedText>
            ) : null}

            <View style={styles.cardBottom}>
              <ModelSettingsButton label={modelName} onPress={onOpenModelSettings} disabled={!tunable} />

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Send"
                accessibilityState={{
                  disabled: !value.trim() || sending || answerPending || requestUsesForm,
                }}
                disabled={!value.trim() || sending || answerPending || requestUsesForm}
                onPress={onSend}
                style={({ pressed }) => [
                  styles.send,
                  {
                    backgroundColor: value.trim() && !sending && !answerPending && !requestUsesForm
                      ? theme.accent
                      : 'rgba(255, 255, 255, 0.08)',
                    opacity: pressed ? 0.75 : 1,
                  },
                ]}>
                <AppIcon
                  name={{ ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' }}
                  size={18}
                  tintColor={
                    value.trim() && !sending && !answerPending && !requestUsesForm
                      ? theme.onAccent
                      : theme.textMuted
                  }
                  fallback="↑"
                />
              </Pressable>
            </View>
          </View>
        </GlassSurface>
      </View>
    </View>
  );
}

function ModelSettingsButton({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Model Settings: ${label}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.pill,
        {
          backgroundColor: pressed
            ? 'rgba(255, 255, 255, 0.12)'
            : 'rgba(255, 255, 255, 0.06)',
          borderColor: theme.glassBorder,
          opacity: disabled ? 0.5 : 1,
        },
      ]}>
      <ThemedText
        type="smallBold"
        numberOfLines={1}
        ellipsizeMode="tail"
        style={{ color: theme.text, fontSize: 13, flexShrink: 1 }}>
        {label}
      </ThemedText>
      {disabled ? null : (
        <AppIcon
          name={{ ios: 'chevron.down', android: 'expand_more', web: 'expand_more' }}
          size={14}
          tintColor={theme.textSecondary}
          fallback="⌄"
        />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  composer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.two,
    paddingTop: Spacing.two,
    paddingBottom: Spacing.two,
    gap: Spacing.one,
  },
  cardWrapper: {
    borderRadius: Radius.glass,
    overflow: 'hidden',
  },
  cardSurface: {
    borderRadius: Radius.glass,
    overflow: 'hidden',
    padding: 0,
  },
  cardContent: {
    paddingHorizontal: Spacing.two,
    paddingTop: Spacing.one + Spacing.half,
    paddingBottom: Spacing.one + Spacing.half,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  atButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  latest: {
    marginLeft: 'auto',
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.half,
    paddingHorizontal: Spacing.one,
    borderRadius: Radius.pill,
  },
  atText: {
    fontSize: 14,
    fontFamily: Fonts.medium,
    fontWeight: '500',
    color: Colors.textSecondary,
    marginTop: -1,
  },
  input: {
    paddingHorizontal: 0,
    paddingTop: 4,
    paddingBottom: 4,
    minHeight: MIN_INPUT_HEIGHT,
    maxHeight: MAX_INPUT_HEIGHT,
    fontFamily: Fonts.regular,
    fontSize: 16,
    textAlignVertical: 'top',
    includeFontPadding: false,
  },
  cardBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
    marginTop: Spacing.one,
    minHeight: 36,
  },
  pill: {
    flexShrink: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: Radius.pill,
    borderWidth: 1,
  },
  send: {
    flexShrink: 0,
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18,
    overflow: 'hidden',
  },
});
