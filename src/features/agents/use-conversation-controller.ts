import { useCallback, useEffect, useRef, useState } from 'react';

import type { AgentCompletion, AgentConversation, RemoteAgent } from '@/domain/herdr';
import { isBridgeUnavailable } from '@/services/herdr-bridge-transport';
import { toUserMessage } from '@/utils/user-error';
import { conversationRefreshInterval, startConversationRefresh } from './conversation-refresh';

export interface ConversationReader {
  hydrate(): Promise<void>;
  restoreConversation(agentId: string): Promise<void>;
  loadConversation(agentId: string): Promise<AgentConversation>;
  getCompletion(agentId: string): AgentCompletion | undefined;
  markCompletionRead(agentId: string, expectedId: string): Promise<void>;
}

type Options = {
  conversationId?: string;
  agent?: RemoteAgent;
  hasOpenRequest: boolean;
  connected: boolean;
  focused: boolean;
  foreground: boolean;
  repository: ConversationReader;
};

export function useConversationController({
  conversationId,
  agent,
  hasOpenRequest,
  connected,
  focused,
  foreground,
  repository,
}: Options) {
  const agentId = agent?.id;
  const status = agent?.status;
  const provider = agent?.provider;
  const paneId = agent?.paneId;
  const sessionId = agent?.providerSessionId;
  const completionId = agent?.completion?.id;
  const streaming = agent?.capabilities.streamingConversation === true;
  const scope = JSON.stringify([conversationId, provider, paneId, sessionId]);
  const [failure, setFailure] = useState<{
    scope: string;
    message: string;
    source: 'restore' | 'read' | 'completion';
  } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const restoreKey = JSON.stringify([scope, reloadToken]);
  const [restoredKey, setRestoredKey] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const retry = useCallback(() => setReloadToken((value) => value + 1), [setReloadToken]);

  useEffect(() => {
    if (!conversationId) return;
    let cancelled = false;
    // Metadata and cached messages restore together, without gating online reads.
    void Promise.all([repository.hydrate(), repository.restoreConversation(conversationId)]).then(() => {
      if (!cancelled) {
        setRestoredKey(restoreKey);
        setFailure((current) =>
          current?.scope === scope && current.source === 'restore' ? null : current);
      }
    }, (error: unknown) => {
      if (!cancelled) {
        setRestoredKey(restoreKey);
        setFailure({ scope, message: toUserMessage(error), source: 'restore' });
      }
    });
    return () => { cancelled = true; };
  }, [conversationId, repository, scope, restoreKey]);

  useEffect(() => {
    if (!agentId || !connected || !focused || !foreground) return;
    let cancelled = false;
    let readCompletionId: string | undefined;
    let readRevision = 0;
    const stop = startConversationRefresh({
      interval: conversationRefreshInterval(status, hasOpenRequest, streaming),
      inFlight,
      refresh: () => {
        readRevision++;
        const completion = repository.getCompletion(agentId);
        readCompletionId = completion?.unread ? completion.id : undefined;
        return repository.loadConversation(agentId);
      },
      onSuccess: () => {
        setFailure(null);
        if (!readCompletionId) return;
        const revision = readRevision;
        void repository.markCompletionRead(agentId, readCompletionId).catch((error: unknown) => {
          console.warn('[COMPLETION] Could not save completion read state', error);
          // A late failed receipt must not replace the result of a newer read.
          if (!cancelled && revision === readRevision) {
            setFailure({ scope, message: toUserMessage(error), source: 'completion' });
          }
        });
      },
      onError: (error) => {
        console.warn('[CONVERSATION] Could not load conversation', error);
        setFailure({
          scope,
          source: 'read',
          message: isBridgeUnavailable(error)
            ? 'Not connected to this agent\u2019s device.'
            : toUserMessage(error),
        });
      },
    });
    return () => { cancelled = true; stop(); };
  }, [
    agentId, completionId, connected, focused, foreground, hasOpenRequest,
    reloadToken, repository, scope, status, streaming,
  ]);

  return {
    error: failure?.scope === scope ? failure.message : null,
    restoring: Boolean(conversationId) && restoredKey !== restoreKey,
    retry,
  };
}
