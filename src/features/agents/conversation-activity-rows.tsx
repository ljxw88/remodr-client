import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { AppIcon, type AppIconName } from '@/components/ui/app-icon';
import { Radius, Spacing } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { planProgress, type PlanItem, type ToolActivityItem } from './conversation-display';

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
          <ActivityIndicator size="small" color={theme.accent} />
        ) : (
          <AppIcon
            name={toolStateIcon(item.state)}
            size={14}
            tintColor={tone}
            fallback={item.state === 'failed' || item.state === 'cancelled' ? '✕' : '·'}
          />
        )}
      </View>
      <View style={styles.toolCopy}>
        <ThemedText type="smallBold">{item.title}</ThemedText>
        {item.detail ? (
          <ThemedText type="caption" themeColor="textSecondary">{item.detail}</ThemedText>
        ) : null}
      </View>
      {label ? (
        <ThemedText type="caption" style={{ color: tone }}>{label}</ThemedText>
      ) : null}
    </View>
  );
}

export function PlanRow({ todos }: { todos: PlanItem[] }) {
  const theme = useTheme();
  const { done, total } = planProgress(todos);

  return (
    <View style={[styles.plan, { backgroundColor: theme.glass, borderColor: theme.glassBorder }]}>
      <View style={styles.planHeader}>
        <ThemedText type="smallBold">Plan</ThemedText>
        <ThemedText type="caption" themeColor="textMuted">{done} of {total}</ThemedText>
      </View>
      {todos.map((todo, index) => (
        <PlanStep key={todo.id ?? `${index}:${todo.text}`} todo={todo} />
      ))}
    </View>
  );
}

function PlanStep({ todo }: { todo: PlanItem }) {
  const theme = useTheme();
  const active = todo.state === 'in_progress';
  const finished = todo.state === 'done';
  const blocked = todo.state === 'blocked';

  return (
    <View accessible accessibilityLabel={`${todo.text}, ${todo.state.replace('_', ' ')}`} style={styles.planStep}>
      <View style={styles.mark}>
        {active ? (
          <ActivityIndicator size="small" color={theme.accent} />
        ) : (
          <AppIcon
            name={planStateIcon(todo.state)}
            size={14}
            tintColor={blocked ? theme.warning : theme.textMuted}
            fallback={finished ? '✓' : blocked ? '!' : '○'}
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
  return { ios: 'circle', android: 'radio_button_unchecked', web: 'radio_button_unchecked' };
}

function toolStateIcon(state: ToolActivityItem['state']): AppIconName {
  if (state === 'completed') return { ios: 'checkmark', android: 'check', web: 'check' };
  if (state === 'failed' || state === 'cancelled') return { ios: 'xmark', android: 'close', web: 'close' };
  return { ios: 'circle', android: 'radio_button_unchecked', web: 'radio_button_unchecked' };
}

const styles = StyleSheet.create({
  toolCall: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.one,
    paddingHorizontal: Spacing.one, paddingVertical: Spacing.half + 2,
  },
  toolCopy: { flex: 1, gap: 3 },
  mark: { width: 18, minHeight: 20, alignItems: 'center', justifyContent: 'center' },
  plan: {
    gap: Spacing.half, padding: Spacing.one + Spacing.half,
    borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: Radius.control,
  },
  planHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: Spacing.one, paddingBottom: Spacing.half,
  },
  planStep: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.one },
  planStepText: { flex: 1 },
});
