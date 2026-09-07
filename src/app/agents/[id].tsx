import { router, Stack, useFocusEffect, useIsFocused, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  Pressable,
  StyleSheet,
  View,
} from 'react-native';

import { Screen } from '@/components/ui/screen';
import { ThemedText } from '@/components/themed-text';
import { Colors, Fonts, Radius, Spacing } from '@/constants/theme';
import {
  providerLabel,
  statusLabel,
  type RemoteAgent,
} from '@/domain/herdr';
import { modelLabel } from '@/domain/agent-catalogue';
import { supportsRetuning } from '@/domain/agent-capabilities';
import { agentSession, commandSession, sameAgentSession } from '@/domain/agent-session';
import { beginAgentSettingsFlow, beginRenameAgentFlow } from '@/features/agents/agent-edit-flow';
import { ActionMenu } from '@/components/ui/action-menu';
import { ConversationComposer } from '@/features/agents/conversation-composer';
import { ConversationMessageList } from '@/features/agents/conversation-message-list';
import { ConversationActivityPanel } from '@/features/agents/conversation-activity-panel';
import { HumanRequestBar } from '@/features/agents/human-request-bar';
import { useAgentConversation, useHerdr } from '@/features/agents/use-herdr';
import { useConversationController } from '@/features/agents/use-conversation-controller';
import { useConversationScroll } from '@/features/agents/use-conversation-scroll';
import { usePersistedDraft } from '@/features/agents/use-persisted-draft';
import { ConnectionStatus } from '@/features/connection/connection-status';
import { useConnectionSnapshot, useForeground, usePendingCommands } from '@/features/connection/use-connection';
import {
  conversationTranscript,
  currentToolActivity,
  type TranscriptItem,
} from '@/features/agents/conversation-display';
import { useTheme } from '@/hooks/use-theme';
import { useKeyboardOverlap } from '@/hooks/use-keyboard-overlap';
import { herdrRepository } from '@/services/herdr-repository';
import { toUserMessage } from '@/utils/user-error';

export default function AgentConversationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const runtime = useHerdr();
  const agent = Object.values(runtime.devices)
    .flatMap((device) => device.runtime.agents)
    .find((item) => item.id === id);
  const agentStatus = agent?.status;
  const conversation = useAgentConversation(id ?? '');
  const hasOpenRequest = conversation?.activeHumanRequest != null;
  // A cached runtime can name an agent well before its device transport is up,
  // and a conversation fetched in that window throws. Following the owning
  // device's connection gives the fetch a trigger to run again on.
  const ownerDeviceId = herdrRepository.deviceIdForAgent(id ?? '');
  const ownerConnection = ownerDeviceId
    ? runtime.devices[ownerDeviceId]?.connection
    : undefined;
  const ownerSnapshot = useConnectionSnapshot(ownerDeviceId);
  const foreground = useForeground();
  const focused = useIsFocused();
  const { ref: keyboardViewport, inset: keyboardHeight, measure: measureKeyboard } = useKeyboardOverlap(focused && foreground);
  const commands = usePendingCommands();
  const ownerConnected = ownerConnection === 'connected' &&
    (!ownerSnapshot || ownerSnapshot.phase === 'connected');
  const { error: conversationError, retry: retryConversation } = useConversationController({
    conversationId: id,
    agent,
    hasOpenRequest,
    connected: ownerConnected,
    focused,
    foreground,
    repository: herdrRepository,
  });
  const { draft, error: draftError, changeDraft: updateDraft, captureSend } = usePersistedDraft({
    agentId: id,
    repository: herdrRepository,
    focused,
    foreground,
  });
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [composerHeight, setComposerHeight] = useState(0);
  const [closingAgent, setClosingAgent] = useState(false);
  const closingAgentRef = useRef(false);
  const navigating = useRef(false);
  const actionVisible = useRef(false);
  const mounted = useRef(false);
  const listRef = useRef<FlatList<TranscriptItem>>(null);
  const scrollToLatest = useCallback((animated: boolean) => {
    listRef.current?.scrollToOffset({ offset: 0, animated });
  }, []);
  const scroll = useConversationScroll({
    conversationId: id,
    active: focused && foreground,
    scrollToLatest,
  });
  const sendingRef = useRef(false);
  const currentAgentId = useRef(id);
  useLayoutEffect(() => { currentAgentId.current = id; }, [id]);
  const requestId = conversation?.activeHumanRequest?.id;
  const answerPending = commands.some((command) =>
    command.agentId === id && command.action === 'human_request.answer' &&
    sameAgentSession(commandSession(command.payload), agentSession(agent)) &&
    command.payload.requestId === requestId,
  );

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useFocusEffect(useCallback(() => {
    navigating.current = false;
    actionVisible.current = true;
    return () => { actionVisible.current = false; };
  }, []));

  function openAgentForm(kind: 'settings' | 'rename') {
    if (!agent || navigating.current || closingAgentRef.current) return;
    try {
      const flowId = kind === 'settings' ? beginAgentSettingsFlow(agent) : beginRenameAgentFlow(agent);
      navigating.current = true;
      Keyboard.dismiss();
      router.push({ pathname: kind === 'settings' ? '/flows/agent-settings' : '/flows/rename-agent', params: { flowId } });
    } catch (error) {
      navigating.current = false;
      Alert.alert('Could not open agent options', toUserMessage(error));
    }
  }

  function confirmCloseAgent() {
    if (!agent || closingAgentRef.current) return;
    const target = agent;
    Alert.alert('Close this agent?', `${target.title} will stop, and its conversation will no longer be reachable.`, [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Close agent', style: 'destructive',
        onPress: () => {
          if (closingAgentRef.current) return;
          closingAgentRef.current = true;
          setClosingAgent(true);
          void herdrRepository.closeAgent(target.id).then(() => {
            if (actionVisible.current) router.dismissTo('/');
          }).catch((error) => {
            if (actionVisible.current) Alert.alert('Could not close agent', toUserMessage(error));
            else console.warn('[AGENT] Could not close agent', error);
          }).finally(() => {
            closingAgentRef.current = false;
            if (mounted.current) setClosingAgent(false);
          });
        },
      },
    ]);
  }

  function changeDraft(text: string) {
    updateDraft(text);
    setSendError(null);
  }

  /**
   * Newest first, because the transcript renders inverted. Offset zero is then
   * the newest message, so opening a conversation lands at the bottom by
   * construction rather than by scrolling there once the rows have measured.
   */
  const displayItems = useMemo(
    () => conversationTranscript(conversation?.items ?? []).reverse(),
    [conversation?.items],
  );
  const activeTool = currentToolActivity(conversation?.items ?? [], agentStatus);
  const working = agentStatus === 'working';
  const workingLabel = activeTool?.title
    ? `${activeTool.title}…`
    : `${agent ? providerLabel(agent.provider) : 'The agent'} is working`;
  const scheduleScroll = scroll.schedule;

  useEffect(() => {
    scheduleScroll();
  }, [displayItems, composerHeight, keyboardHeight, scheduleScroll]);

  if (!agent) {
    return (
      <Screen>
        <Stack.Screen options={{ title: 'Agent' }} />
        <ThemedText>This agent is no longer available.</ThemedText>
      </Screen>
    );
  }

  async function send() {
    if (sendingRef.current || !agent) {
      return;
    }
    if (requestId && herdrRepository.getPendingCommands().some((command) =>
      command.agentId === agent.id && command.action === 'human_request.answer' &&
      sameAgentSession(commandSession(command.payload), agentSession(agent)) &&
      command.payload.requestId === requestId,
    )) {
      setSendError('An answer is already queued. Review its delivery status before answering again.');
      return;
    }
    const submission = captureSend();
    if (!submission?.text) {
      submission?.cancel();
      return;
    }
    const text = submission.text;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    scroll.followLatest();
    try {
      if (conversation?.activeHumanRequest) {
        await herdrRepository.answerHumanRequest(
          agent.id,
          conversation.activeHumanRequest.id,
          { customText: text },
        );
      } else {
        await herdrRepository.sendMessage(agent.id, text);
      }
      // Enqueue is already durable. A draft-clear failure is reported separately
      // by the hook and must not make the user think sending failed.
      await submission.complete().catch(() => undefined);
      if (mounted.current && currentAgentId.current === submission.agentId) scroll.schedule();
    } catch (error) {
      if (mounted.current && currentAgentId.current === submission.agentId) setSendError(toUserMessage(error));
      else console.warn('[CONVERSATION] Could not queue message', error);
    } finally {
      submission.cancel();
      sendingRef.current = false;
      if (mounted.current) setSending(false);
    }
  }

  return (
    <Screen style={styles.screen}>
      <Stack.Screen
        options={{
          title: agent.title,
          headerTitleStyle: {
            fontSize: 15,
            fontFamily: Fonts.semibold,
            fontWeight: 600,
          },
          /**
           * The only sign that the agent is busy. It used to be a labelled row
           * above the composer, which took a band of the transcript for a
           * sentence that said what the spinner already says, and moved the
           * composer every time the agent started or stopped.
           *
           * The label lives on for screen readers, which get nothing from a
           * spinner on its own.
           */
          headerRight: () => (
            <View style={styles.headerActions}>
              {working ? (
                <ActivityIndicator
                  size="small"
                  color={Colors.accent}
                  accessibilityLabel={workingLabel}
                />
              ) : null}
              <ActionMenu
                label="Agent options"
                disabled={closingAgent}
                items={[
                  { id: 'rename', label: 'Rename Agent', onPress: () => openAgentForm('rename') },
                  { id: 'settings', label: 'Model Settings', disabled: !supportsRetuning(agent.provider, agent.capabilities), onPress: () => openAgentForm('settings') },
                  { id: 'diagnostics', label: 'Session diagnostics', onPress: () => router.push({ pathname: '/diagnostics', params: { agentId: agent.id } }) },
                  { id: 'close', label: 'Close agent', destructive: true, disabled: !ownerConnected, onPress: confirmCloseAgent },
                ]}
              />
            </View>
          ),
        }}
      />
      <View ref={keyboardViewport} onLayout={measureKeyboard} collapsable={false} style={styles.flex}>
        {/* ScrollEdgeFrame supplies the transcript blur target. Keep the
            composer and reconnect overlay outside it. */}
        <View style={styles.flex}>
          <AgentHeader agent={agent} connected={ownerConnected} />
          <ConversationActivityPanel
            sessionKey={JSON.stringify([id, agent.provider, agent.paneId, agent.providerSessionId ?? null])}
            items={conversation?.items ?? []}
            active={focused && foreground}
            keyboardInset={keyboardHeight}
          />
          <ConversationMessageList
            conversationId={id}
            data={displayItems}
            listRef={listRef}
            agent={agent}
            onEdit={changeDraft}
            connected={ownerConnected}
            error={conversationError}
            hasConversation={conversation != null}
            bottomInset={composerHeight + keyboardHeight}
            onRetry={retryConversation}
            scroll={scroll}
          />
        </View>
        <ConversationComposer
          value={draft}
          onChangeText={changeDraft}
          onSend={() => void send()}
          sending={sending}
          answerPending={answerPending}
          error={[sendError, draftError].filter(Boolean).join('\n') || null}
          hasOpenRequest={hasOpenRequest}
          requestBar={conversation?.activeHumanRequest ? (
            // A new question or session starts with a clean selection.
            <HumanRequestBar
              key={JSON.stringify([agent.provider, agent.paneId, agent.providerSessionId ?? null, conversation.activeHumanRequest.id])}
              agentId={agent.id}
              session={{ provider: agent.provider, paneId: agent.paneId, providerSessionId: agent.providerSessionId ?? null }}
              request={conversation.activeHumanRequest}
              enqueueing={sending}
              enqueueGuard={sendingRef}
              onAnswer={scroll.followLatest}
            />
          ) : null}
          onHeightChange={setComposerHeight}
          modelName={modelLabel(agent.provider, agent.tuning?.model)}
          tunable={supportsRetuning(agent.provider, agent.capabilities)}
          onOpenModelSettings={() => openAgentForm('settings')}
          keyboardOffset={keyboardHeight}
          showLatest={!scroll.following}
          onFollowLatest={scroll.followLatest}
        />
        <ConnectionStatus
          deviceId={ownerDeviceId}
          agentId={agent.id}
          bottomInset={composerHeight + keyboardHeight}
        />
      </View>
    </Screen>
  );
}

function AgentHeader({ agent, connected }: { agent: RemoteAgent; connected: boolean }) {
  const theme = useTheme();
  const statusColor =
    agent.status === 'working'
      ? theme.accent
      : agent.status === 'blocked'
        ? theme.warning
        : agent.status === 'done'
          ? theme.success
          : theme.textMuted;
  return (
    <View style={[styles.context, { borderBottomColor: theme.border }]}>
      <View style={styles.contextCopy}>
        <ThemedText
          type="caption"
          themeColor="textSecondary"
          numberOfLines={1}
          style={styles.pathText}>
          {agent.cwd ?? agent.workspaceName}
        </ThemedText>
        <View style={styles.rightGroup}>
          <View style={styles.statusLine}>
            <View
              style={[
                styles.statusDot,
                {
                  backgroundColor: agent.status === 'idle' ? 'transparent' : statusColor,
                  borderColor: statusColor,
                },
              ]}
            />
            <ThemedText type="caption" style={{ color: statusColor }}>
              {statusLabel(agent.status)}
            </ThemedText>
          </View>
          {agent.status === 'working' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop current agent operation"
              accessibilityHint={connected ? undefined : 'Reconnect before stopping this operation'}
              accessibilityState={{ disabled: !connected }}
              disabled={!connected}
              onPress={() => {
                void herdrRepository.interrupt(agent.id).catch((error) => {
                  Alert.alert(
                    'Could not stop agent',
                    error instanceof Error ? error.message : 'The agent could not be stopped.',
                  );
                });
              }}
              style={({ pressed }) => [styles.stop, { borderColor: theme.border, opacity: connected ? 1 : 0.4 }, pressed && styles.pressed]}>
              <ThemedText type="caption" style={styles.stopText}>Stop</ThemedText>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    paddingHorizontal: 0,
    paddingTop: 0,
  },
  flex: {
    flex: 1,
  },
  context: {
    minHeight: 28,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one,
    paddingHorizontal: Spacing.two,
    paddingVertical: 2,
    borderBottomWidth: 0,
  },
  contextCopy: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.two,
  },
  rightGroup: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.one + Spacing.half,
  },
  pathText: {
    flexShrink: 1,
  },
  statusLine: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderWidth: 1,
    borderRadius: 3,
  },
  stop: {
    minHeight: 24,
    justifyContent: 'center',
    paddingHorizontal: Spacing.one + Spacing.half,
    borderWidth: 1,
    borderRadius: Radius.pill,
  },
  stopText: {
    fontFamily: Fonts.semibold,
    fontWeight: 600,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    marginRight: Spacing.one,
  },
  pressed: {
    opacity: 0.6,
  },
});
