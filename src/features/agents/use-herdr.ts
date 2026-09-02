import { useSyncExternalStore } from 'react';

import type { AgentConversation } from '@/domain/herdr';
import { herdrRepository } from '@/services/herdr-repository';

export function useHerdr() {
  return useSyncExternalStore(
    herdrRepository.subscribe,
    herdrRepository.getSnapshot,
    herdrRepository.getSnapshot,
  );
}

export function useAgentConversation(agentId: string): AgentConversation | null {
  return useSyncExternalStore(
    herdrRepository.subscribeConversations,
    () => herdrRepository.getConversation(agentId),
    () => null,
  );
}
