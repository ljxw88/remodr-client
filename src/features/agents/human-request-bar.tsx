import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { AppIcon } from '@/components/ui/app-icon';
import { GlassSurface, glassRim } from '@/components/ui/glass-surface';
import { Radius, Spacing } from '@/constants/theme';
import type { HumanRequest } from '@/domain/herdr';
import { commandSession, sameAgentSession, type AgentSession } from '@/domain/agent-session';
import { answerBodyFor, answerOptions } from '@/features/agents/human-request';
import { CommandDelivery } from '@/features/connection/connection-status';
import { usePendingCommands } from '@/features/connection/use-connection';
import { useTheme } from '@/hooks/use-theme';
import { herdrRepository } from '@/services/herdr-repository';
import { toUserMessage } from '@/utils/user-error';

type Props = {
  agentId: string;
  session: AgentSession;
  request: HumanRequest;
  enqueueing?: boolean;
  enqueueGuard?: { current: boolean };
  onAnswer?: () => void;
};

/**
 * The agent's open question, pinned above the composer.
 *
 * It sits here rather than only in the transcript because an unanswered
 * question blocks the agent: scrolling away from it should not hide the thing
 * the agent is waiting on. The transcript keeps the record; this is the
 * control.
 *
 * The composer stays usable throughout. Every option is a shortcut for typing
 * an answer — the bridge resolves a chosen option back to its label and sends
 * that as the prompt — so a question the options do not cover can always be
 * answered in words instead.
 */
export function HumanRequestBar({ agentId, session, request, enqueueing = false, enqueueGuard, onAnswer }: Props) {
  const theme = useTheme();
  const [selected, setSelected] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * `sending` only shuts the buttons once React has re-rendered, which leaves
   * a frame in which a second tap still sees the old value. Answering twice
   * sends the agent a second prompt it never asked for.
   */
  const localInFlight = useRef(false);
  const inFlight = enqueueGuard ?? localInFlight;
  const commands = usePendingCommands();
  const command = commands.find((entry) =>
    entry.agentId === agentId && entry.action === 'human_request.answer' &&
    sameAgentSession(commandSession(entry.payload), session) &&
    entry.payload.requestId === request.id,
  );
  const sent = acknowledged || command?.state === 'sent';

  const options = answerOptions(request);
  const locked = sending || enqueueing || sent || command != null;
  const promptOnly = options.length === 0;

  useEffect(() => {
    const observe = () => {
      if (herdrRepository.getPendingCommands().some((entry) =>
        entry.agentId === agentId && entry.action === 'human_request.answer' &&
        sameAgentSession(commandSession(entry.payload), session) &&
        entry.payload.requestId === request.id && entry.state === 'sent',
      )) setAcknowledged(true);
    };
    observe();
    return herdrRepository.subscribeCommands(observe);
  }, [agentId, request.id, session]);

  async function answer(optionIds: string[]) {
    if (inFlight.current || locked || optionIds.length === 0 ||
      herdrRepository.getPendingCommands().some((entry) =>
        entry.agentId === agentId && entry.action === 'human_request.answer' &&
        sameAgentSession(commandSession(entry.payload), session) &&
        entry.payload.requestId === request.id,
      )) {
      return;
    }
    inFlight.current = true;
    setSending(true);
    setError(null);
    onAnswer?.();
    try {
      await herdrRepository.answerHumanRequest(
        agentId,
        request.id,
        answerBodyFor(request, optionIds),
      );
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  function choose(optionId: string) {
    if (request.multiSelect) {
      setSelected((current) =>
        current.includes(optionId)
          ? current.filter((item) => item !== optionId)
          : [...current, optionId],
      );
      return;
    }
    void answer([optionId]);
  }

  return (
    <View style={styles.wrapper}>
      {/* A surface of its own rather than bare text over the composer. The
          transcript scrolls underneath this at every position but the very
          bottom, and without something opaque the two read straight through
          each other. Same chrome as the input card below, so the pair reads as
          one stack. */}
      <GlassSurface tone="chrome" strength="strong" highlight style={styles.surface}>
        <View style={styles.content}>
          <View style={styles.heading}>
            <AppIcon
              name={{ ios: 'questionmark.circle', android: 'help', web: 'help' }}
              size={14}
              tintColor={theme.accentSecondary}
              fallback="?"
            />
            <ThemedText type="label" style={{ color: theme.accentSecondary }}>
              {sent ? 'ANSWER SENT'
                : command?.state === 'failed' || command?.state === 'uncertain' ? 'REVIEW ANSWER'
                  : command ? 'ANSWER QUEUED'
                    : request.multiSelect ? 'CHOOSE ANY' : 'NEEDS YOUR INPUT'}
            </ThemedText>
          </View>

          {/* Tappable to expand, because while the question is open this is its
              only rendering — the transcript keeps one only once it is
              answered — and the bridge falls back to a schema field's
              description, which is prose. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={request.question}
            accessibilityState={{ expanded }}
            onPress={() => setExpanded((current) => !current)}>
            <ThemedText type="small" numberOfLines={expanded ? undefined : 3}>
              {request.question}
            </ThemedText>
          </Pressable>

          {promptOnly ? (
            <ThemedText type="caption" themeColor="textMuted">
              Type an answer below.
            </ThemedText>
          ) : null}

          <View style={styles.options}>
            {options.map((option) => {
              const isSelected = selected.includes(option.id);
              return (
                <Pressable
                  key={option.id}
                  accessibilityRole={request.multiSelect ? 'checkbox' : 'button'}
                  accessibilityLabel={option.label}
                  accessibilityHint={option.description ?? undefined}
                  accessibilityState={{ selected: isSelected, disabled: locked }}
                  disabled={locked}
                  onPress={() => choose(option.id)}
                  style={({ pressed }) => [
                    styles.option,
                    glassRim(isSelected ? theme.accent : undefined),
                    {
                      backgroundColor: isSelected
                        ? theme.accentSoft
                        : theme.backgroundElement,
                      opacity: locked ? 0.5 : pressed ? 0.72 : 1,
                    },
                  ]}>
                  <ThemedText
                    type="smallBold"
                    style={{ color: theme.text }}>
                    {option.label}
                  </ThemedText>
                </Pressable>
              );
            })}
          </View>

          {request.multiSelect ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send selected answers"
              accessibilityState={{ disabled: locked || selected.length === 0 }}
              disabled={locked || selected.length === 0}
              onPress={() => void answer(selected)}
              style={({ pressed }) => [
                styles.confirm,
                {
                  backgroundColor: theme.accent,
                  opacity:
                    locked || selected.length === 0 ? 0.4 : pressed ? 0.8 : 1,
                },
              ]}>
              <ThemedText type="smallBold" style={{ color: theme.onAccent }}>
                {sent
                  ? 'Answer sent'
                  : command?.state === 'failed' || command?.state === 'uncertain'
                    ? 'Review answer'
                  : command
                    ? 'Answer queued'
                  : selected.length > 0
                    ? `Send ${selected.length} selected`
                    : 'Select an answer'}
              </ThemedText>
            </Pressable>
          ) : null}

          {command ? (
            <CommandDelivery
              commandId={command.id}
              delivery={command.state}
              deliveryError={command.error}
              discardLabel="Discard answer and choose again"
              onDiscard={() => {
                setAcknowledged(false);
                setError(null);
              }}
            />
          ) : null}

          {error ? (
            <ThemedText type="caption" themeColor="danger">
              {error}
            </ThemedText>
          ) : null}
        </View>
      </GlassSurface>
    </View>
  );
}

/**
 * Rounded at the head, square at the foot.
 *
 * The foot is overlapped by the input card, and two curves meeting there
 * pinched the join into an hourglass — the card's own corners plus a set of
 * ours showing just above them. Square, there is nothing left to see: the
 * sides run straight down behind the card, and the only corners on show are
 * the card's.
 */
const OPTION_HEIGHT = 40;

/**
 * How far the panel runs on underneath the input card.
 *
 * It has to clear the card's corner radius. The card only starts covering
 * things at its own corners once you are that far down, so a shallower
 * overlap leaves our square foot poking out into the notch beside each curve.
 */
const TUCK = Radius.glass + Spacing.half;

const SQUARE_FOOT = {
  borderTopLeftRadius: Radius.glass,
  borderTopRightRadius: Radius.glass,
  borderBottomLeftRadius: 0,
  borderBottomRightRadius: 0,
} as const;

const styles = StyleSheet.create({
  wrapper: {
    ...SQUARE_FOOT,
    overflow: 'hidden',
    // Runs on behind the input card rather than stopping short of it. The
    // composer's gap would otherwise be a band of clear space with the
    // transcript scrolling through it, between two panels that read as one.
    // The gap is cancelled first, then the tuck taken off that.
    marginBottom: -(Spacing.one + TUCK),
  },
  surface: {
    ...SQUARE_FOOT,
    overflow: 'hidden',
    padding: 0,
  },
  content: {
    paddingHorizontal: Spacing.two,
    paddingTop: Spacing.one + Spacing.half,
    // The tuck is hidden behind the card, so it is added on top of the room
    // the answers actually need.
    paddingBottom: Spacing.two + TUCK,
    // The label is a caption for the question, so it sits closer to it than
    // the answers do. An even gap throughout read as three unrelated rows.
    gap: Spacing.one,
  },
  heading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.half,
    // Pulled up against the question it introduces.
    marginBottom: -Spacing.half,
  },
  options: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one,
    // Answers are the action, so they get more room above them than the
    // question got below its label.
    marginTop: Spacing.half,
  },
  option: {
    minHeight: OPTION_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    // An answer can be a sentence rather than a word, and one wider than the
    // bar used to run out past its own edge.
    flexShrink: 1,
    maxWidth: '100%',
    /**
     * Half the height it can never go under, so a one-line answer is a true
     * pill. `Radius.pill` is 999, which on an answer that wraps to four lines
     * curves the ends so far in that they cut through the text.
     */
    borderRadius: OPTION_HEIGHT / 2,
  },
  confirm: {
    minHeight: OPTION_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.pill,
  },
});
