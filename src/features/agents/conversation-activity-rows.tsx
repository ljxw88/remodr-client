import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { AppIcon, type AppIconName } from '@/components/ui/app-icon';
import { ChipGeometry, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { ActivityLayout } from './conversation-activity-layout';
import { type PlanItem, type ToolActivityItem } from './conversation-display';

// Apply the matching right inset inside rows; Android's inverted list mirrors container padding.
const ACTIVITY_STATUS_INSET = ActivityLayout.disclosureInset;

/** The panel is the disclosure; individual calls keep their details visible. */
export function ToolActivityRow({ item }: { item: ToolActivityItem }) {
  const theme = useTheme();
  const tone = item.state === 'failed' ? theme.danger
    : item.state === 'running' ? theme.accent : theme.textMuted;
  const label = item.state === 'completed' ? '' : item.state[0].toUpperCase() + item.state.slice(1);

  return (
    <View
      accessible
      accessibilityLabel={[item.title, item.state, item.detail].filter(Boolean).join('. ')}
      style={styles.toolCall}>
      <View style={styles.mark}>
        {item.state === 'running' ? (
          <ActivityIndicator size={ActivityLayout.iconSize} color={theme.accent} />
        ) : (
          <AppIcon
            name={toolStateIcon(item.state)}
            size={ActivityLayout.iconSize}
            tintColor={tone}
            fallback={item.state === 'failed' || item.state === 'cancelled' ? '✕' : '·'}
          />
        )}
      </View>
      <View style={styles.toolCopy}>
        <View testID="activity-tool-title-row" style={styles.toolTitleRow}>
          <ThemedText type="caption" style={styles.toolTitle}>{item.title}</ThemedText>
          {label ? (
            <ThemedText type="caption" style={[styles.toolStatus, { color: tone }]}>{label}</ThemedText>
          ) : null}
        </View>
        {item.detail ? (
          <ThemedText type="caption" themeColor="textSecondary">{item.detail}</ThemedText>
        ) : null}
      </View>
    </View>
  );
}

export function PlanStep({ todo }: { todo: PlanItem }) {
  const theme = useTheme();
  const active = todo.state === 'in_progress';
  const finished = todo.state === 'done';
  const blocked = todo.state === 'blocked';
  const cancelled = todo.state === 'cancelled';

  return (
    <View accessible accessibilityLabel={`${todo.text}, ${todo.state.replace('_', ' ')}`} style={styles.planStep}>
      <View style={styles.mark}>
        {active ? (
          <ActivityIndicator size={ActivityLayout.iconSize} color={theme.accent} />
        ) : (
          <AppIcon
            name={planStateIcon(todo.state)}
            size={ActivityLayout.iconSize}
            tintColor={blocked ? theme.warning : theme.textMuted}
            fallback={finished ? '✓' : blocked ? '!' : cancelled ? '×' : '○'}
          />
        )}
      </View>
      <ThemedText
        type="caption"
        style={[styles.planStepText, {
          color: active ? theme.accent : blocked ? theme.warning
            : finished ? theme.textMuted : theme.textSecondary,
        }]}>
        {todo.text}
      </ThemedText>
    </View>
  );
}

function planStateIcon(state: PlanItem['state']): AppIconName {
  if (state === 'done') return { ios: 'checkmark', android: 'check', web: 'check' };
  if (state === 'blocked') return { ios: 'exclamationmark.circle.fill', android: 'error', web: 'error' };
  if (state === 'cancelled') return { ios: 'xmark', android: 'close', web: 'close' };
  return { ios: 'circle', android: 'radio_button_unchecked', web: 'radio_button_unchecked' };
}

function toolStateIcon(state: ToolActivityItem['state']): AppIconName {
  if (state === 'completed') return { ios: 'checkmark', android: 'check', web: 'check' };
  if (state === 'failed' || state === 'cancelled') return { ios: 'xmark', android: 'close', web: 'close' };
  return { ios: 'circle', android: 'radio_button_unchecked', web: 'radio_button_unchecked' };
}

const styles = StyleSheet.create({
  toolCall: {
    flexDirection: 'row', alignItems: 'flex-start', gap: ChipGeometry.gap,
    paddingVertical: 0, paddingRight: ACTIVITY_STATUS_INSET,
  },
  toolCopy: { flex: 1, minWidth: 0, gap: Spacing.half },
  toolTitleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.one },
  toolTitle: { flex: 1 },
  toolStatus: { flexShrink: 1, maxWidth: '40%' },
  mark: {
    width: ActivityLayout.iconSize + ACTIVITY_STATUS_INSET,
    minHeight: ActivityLayout.lineHeight, alignItems: 'flex-end', justifyContent: 'center',
  },
  planStep: {
    flexDirection: 'row', alignItems: 'flex-start', gap: ChipGeometry.gap,
    paddingRight: ACTIVITY_STATUS_INSET,
  },
  planStepText: { flex: 1 },
});
