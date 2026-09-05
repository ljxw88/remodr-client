import type { AgentStatus } from '@/domain/herdr';

export function conversationRefreshInterval(
  status: AgentStatus | undefined,
  hasOpenRequest: boolean,
  supportsUpdates: boolean,
): number {
  if (status === 'working' || (status === 'blocked' && !hasOpenRequest)) {
    return supportsUpdates ? 1_000 : 2_000;
  }
  // Status events can precede the provider's final transcript write.
  return 3_000;
}

type Options = {
  interval: number;
  inFlight: { current: Promise<void> | null };
  refresh(): Promise<unknown>;
  onSuccess(): void;
  onError(error: unknown): void;
};

/**
 * Poll the visible, connected conversation. Wait for each request before starting
 * the delay, and share the gate across effect restarts so status changes cannot
 * pile up reads. The caller stops the loop on blur, background or disconnection.
 */
export function startConversationRefresh({
  interval, inFlight, refresh, onSuccess, onError,
}: Options): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function tick() {
    if (inFlight.current) await inFlight.current;
    if (stopped) return;
    const request = Promise.resolve().then(refresh).then(
      () => { if (!stopped) onSuccess(); },
      (error: unknown) => { if (!stopped) onError(error); },
    );
    inFlight.current = request;
    await request;
    if (inFlight.current === request) inFlight.current = null;
    if (!stopped) timer = setTimeout(() => void tick(), interval);
  }

  void tick();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
