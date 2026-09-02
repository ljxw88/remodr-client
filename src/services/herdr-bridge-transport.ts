import {
  bridgeEventSchema,
  bridgeHelloSchema,
  bridgeResponseSchema,
  type BridgeEvent,
  type BridgeHello,
} from '@/domain/herdr';
import { createId } from '@/utils/create-id';
import { getRemoteCoreNativeModule } from '@/services/native-remote-client';

export class HerdrBridgeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HerdrBridgeRequestError';
  }
}

export class HerdrBridgeTransport {
  private bridgeId: string | null = null;
  private subscription: { remove(): void } | null = null;
  private listeners = new Set<(event: BridgeEvent) => void>();
  private bufferedMessages: { bridgeId: string; message: string }[] = [];

  async start(sessionId: string): Promise<BridgeHello> {
    await this.stop();
    const native = getRemoteCoreNativeModule();
    this.subscription = native.addListener('onHerdrMessage', (event) => {
      const payload = event as unknown as { bridgeId: string; message: string };
      if (!this.bridgeId) {
        this.bufferedMessages.push(payload);
        return;
      }
      if (payload.bridgeId === this.bridgeId) {
        this.publish(payload.message);
      }
    });
    const started = await native.startHerdrBridge(sessionId);
    this.bridgeId = started.bridgeId;
    const hello = bridgeHelloSchema.parse(JSON.parse(started.hello));
    for (const event of this.bufferedMessages) {
      if (event.bridgeId === this.bridgeId) {
        this.publish(event.message);
      }
    }
    this.bufferedMessages = [];
    return hello;
  }

  subscribe(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request<T>(action: string, payload: Record<string, unknown>): Promise<T> {
    if (!this.bridgeId) {
      throw new HerdrBridgeRequestError('BRIDGE_NOT_STARTED', 'Herdr bridge is not running.');
    }
    const request = JSON.stringify({
      protocol: 1,
      id: createId(),
      type: 'request',
      action,
      payload,
    });
    const raw = await getRemoteCoreNativeModule().requestHerdrBridge(
      this.bridgeId,
      request,
    );
    const response = bridgeResponseSchema.parse(JSON.parse(raw));
    if (!response.ok) {
      throw new HerdrBridgeRequestError(
        response.error?.code ?? 'BRIDGE_ERROR',
        response.error?.message ?? 'Herdr request failed.',
      );
    }
    return response.payload as T;
  }

  async stop(): Promise<void> {
    const bridgeId = this.bridgeId;
    this.bridgeId = null;
    this.bufferedMessages = [];
    this.subscription?.remove();
    this.subscription = null;
    if (bridgeId) {
      await getRemoteCoreNativeModule().stopHerdrBridge(bridgeId);
    }
  }

  private publish(message: string) {
    try {
      const event = bridgeEventSchema.parse(JSON.parse(message));
      this.listeners.forEach((listener) => listener(event));
    } catch (error) {
      console.warn('[HERDR_BRIDGE] Ignored invalid bridge event', error);
    }
  }
}
