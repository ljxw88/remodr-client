import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { AppIcon } from '@/components/ui/app-icon';
import { GlassSurface, glassRim } from '@/components/ui/glass-surface';
import { Fonts, Radius, Spacing } from '@/constants/theme';
import type { HumanRequest } from '@/domain/herdr';
import { commandSession, sameAgentSession, type AgentSession } from '@/domain/agent-session';
import {
  answerBodyFor,
  answerOptions,
  multiQuestionAnswerBody,
  type AnswerBody,
  type QuestionAnswer,
} from '@/features/agents/human-request';
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
  const [questionIndex, setQuestionIndex] = useState(0);
  const [questionAnswers, setQuestionAnswers] = useState<QuestionAnswer[]>(() =>
    request.questions?.map(() => ({ selectedOptionIds: [], customText: '' })) ?? [],
  );
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

  const structuredQuestions = request.questions && request.questions.length > 1
    ? request.questions
    : null;
  const currentQuestion = structuredQuestions?.[questionIndex];
  const currentAnswer = questionAnswers[questionIndex] ?? {
    selectedOptionIds: [],
    customText: '',
  };
  const options = currentQuestion?.options ?? answerOptions(request);
  const locked = sending || enqueueing || sent || command != null;
  const promptOnly = options.length === 0 && !structuredQuestions;
  const currentReady = Boolean(
    currentAnswer.selectedOptionIds?.length || currentAnswer.customText?.trim(),
  );

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

  async function submit(answerBody: AnswerBody) {
    if (inFlight.current || locked ||
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
        answerBody,
      );
    } catch (cause) {
      setError(toUserMessage(cause));
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  }

  function answer(optionIds: string[]) {
    if (optionIds.length > 0) {
      void submit(answerBodyFor(request, optionIds));
    }
  }

  function updateCurrentAnswer(next: QuestionAnswer) {
    setQuestionAnswers((answers) =>
      answers.map((answer, index) => index === questionIndex ? next : answer),
    );
  }

  function chooseStructured(optionId: string) {
    if (!currentQuestion || locked) return;
    const selected = currentAnswer.selectedOptionIds ?? [];
    updateCurrentAnswer({
      ...currentAnswer,
      selectedOptionIds: currentQuestion.multiSelect
        ? selected.includes(optionId)
          ? selected.filter((item) => item !== optionId)
          : [...selected, optionId]
        : [optionId],
      customText: currentQuestion.multiSelect ? currentAnswer.customText : '',
    });
  }

  function continueStructured() {
    if (!structuredQuestions || !currentReady || locked) return;
    if (questionIndex < structuredQuestions.length - 1) {
      setQuestionIndex((index) => index + 1);
      return;
    }
    try {
      void submit(multiQuestionAnswerBody(request, questionAnswers));
    } catch (cause) {
      setError(toUserMessage(cause));
    }
  }

  function choose(optionId: string) {
    if (structuredQuestions) {
      chooseStructured(optionId);
      return;
    }
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
                    : request.kind === 'permission' ? 'PERMISSION REQUIRED'
                      : request.multiSelect ? 'CHOOSE ANY' : 'NEEDS YOUR INPUT'}
            </ThemedText>
            {structuredQuestions ? (
              <ThemedText type="caption" themeColor="textMuted" style={styles.questionCount}>
                {questionIndex + 1} of {structuredQuestions.length}
              </ThemedText>
            ) : null}
          </View>

          {/* Tappable to expand, because while the question is open this is its
              only rendering — the transcript keeps one only once it is
              answered — and the bridge falls back to a schema field's
              description, which is prose. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={currentQuestion?.question ?? request.question}
            accessibilityState={{ expanded }}
            onPress={() => setExpanded((current) => !current)}>
            <ThemedText type="small" numberOfLines={expanded ? undefined : 3}>
              {currentQuestion?.question ?? request.question}
            </ThemedText>
          </Pressable>

          {promptOnly ? (
            <ThemedText type="caption" themeColor="textMuted">
              Type an answer below.
            </ThemedText>
          ) : null}

          {request.permission?.patterns.length ? (
            <View style={styles.permissionPatterns}>
              {request.permission.patterns.slice(0, 4).map((pattern, index) => (
                <ThemedText
                  key={`${index}:${pattern}`}
                  type="caption"
                  numberOfLines={2}
                  style={[styles.permissionPattern, { color: theme.textSecondary }]}>
                  {pattern}
                </ThemedText>
              ))}
              {request.permission.patterns.length > 4 ? (
                <ThemedText type="caption" themeColor="textMuted">
                  +{request.permission.patterns.length - 4} more
                </ThemedText>
              ) : null}
            </View>
          ) : null}

          <View style={styles.options}>
            {options.map((option) => {
              const isSelected = structuredQuestions
                ? currentAnswer.selectedOptionIds?.includes(option.id) === true
                : selected.includes(option.id);
              return (
                <Pressable
                  key={option.id}
                  accessibilityRole={
                    (currentQuestion?.multiSelect ?? request.multiSelect) ? 'checkbox' : 'button'
                  }
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

          {structuredQuestions && currentQuestion?.allowCustomAnswer ? (
            <TextInput
              accessibilityLabel={`Custom answer for ${currentQuestion.question}`}
              editable={!locked}
              maxLength={4_000}
              multiline
              onChangeText={(customText) => updateCurrentAnswer({
                ...currentAnswer,
                customText,
                selectedOptionIds: currentQuestion.multiSelect
                  ? currentAnswer.selectedOptionIds
                  : [],
              })}
              placeholder="Type another answer"
              placeholderTextColor={theme.placeholder}
              style={[
                styles.customAnswer,
                {
                  borderColor: theme.glassBorder,
                  color: theme.text,
                  backgroundColor: theme.backgroundElement,
                },
              ]}
              value={currentAnswer.customText ?? ''}
            />
          ) : null}

          {structuredQuestions ? (
            <View style={styles.formActions}>
              {questionIndex > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Previous question"
                  disabled={locked}
                  onPress={() => setQuestionIndex((index) => index - 1)}
                  style={({ pressed }) => [
                    styles.previous,
                    {
                      borderColor: theme.glassBorder,
                      opacity: locked ? 0.4 : pressed ? 0.72 : 1,
                    },
                  ]}>
                  <ThemedText type="smallBold">Back</ThemedText>
                </Pressable>
              ) : null}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={
                  questionIndex === structuredQuestions.length - 1
                    ? 'Send all answers'
                    : 'Continue to next question'
                }
                accessibilityState={{ disabled: locked || !currentReady }}
                disabled={locked || !currentReady}
                onPress={continueStructured}
                style={({ pressed }) => [
                  styles.confirm,
                  styles.formContinue,
                  {
                    backgroundColor: theme.accent,
                    opacity: locked || !currentReady ? 0.4 : pressed ? 0.8 : 1,
                  },
                ]}>
                <ThemedText type="smallBold" style={{ color: theme.onAccent }}>
                  {questionIndex === structuredQuestions.length - 1
                    ? 'Send answers'
                    : 'Next'}
                </ThemedText>
              </Pressable>
            </View>
          ) : request.multiSelect ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send selected answers"
              accessibilityState={{ disabled: locked || selected.length === 0 }}
              disabled={locked || selected.length === 0}
              onPress={() => answer(selected)}
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
  questionCount: {
    marginLeft: 'auto',
  },
  options: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.one,
    // Answers are the action, so they get more room above them than the
    // question got below its label.
    marginTop: Spacing.half,
  },
  permissionPatterns: {
    gap: Spacing.half,
  },
  permissionPattern: {
    fontFamily: Fonts.mono,
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
  },
  customAnswer: {
    minHeight: 42,
    maxHeight: 96,
    borderWidth: 1,
    borderRadius: Radius.control,
    paddingHorizontal: Spacing.one + Spacing.half,
    paddingVertical: Spacing.one,
    fontFamily: Fonts.regular,
    fontSize: 14,
    textAlignVertical: 'top',
  },
  formActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: Spacing.one,
  },
  previous: {
    minHeight: OPTION_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: Spacing.two,
    borderWidth: 1,
    borderRadius: Radius.pill,
  },
  formContinue: {
    flex: 0,
    minWidth: 104,
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
