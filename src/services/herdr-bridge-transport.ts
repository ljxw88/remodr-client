import {
  bridgeEventSchema,
  bridgeHelloSchema,
  bridgeResponseSchema,
  type BridgeEvent,
  type BridgeHello,
} from '@/domain/herdr';
import { createId } from '@/utils/create-id';
import { getRemoteCoreNativeModule } from '@/services/native-remote-client';
import { classifyConnectionError, ConnectionError } from '@/domain/connection-error';

export class HerdrBridgeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HerdrBridgeRequestError';
  }
}

/**
 * True when a request failed because the device's bridge is not up.
 *
 * The native module wraps its own rejections, so the same condition arrives
 * either as our typed error or as an Expo "Call to function ... has been
 * rejected" string. Callers care about the condition, not which layer noticed.
 */
export function isBridgeUnavailable(error: unknown): boolean {
  return classifyConnectionError(error).retryable;
}

export class HerdrBridgeTransport {
  private bridgeId: string | null = null;
  private subscription: { remove(): void } | null = null;
  private listeners = new Set<(event: BridgeEvent) => void>();
  private bufferedMessages: { bridgeId: string; message: string }[] = [];
  private generation = 0;

  async start(sessionId: string): Promise<BridgeHello> {
    await this.stop();
    const generation = this.generation;
    const native = getRemoteCoreNativeModule();
    try {
      this.subscription = native.addListener('onHerdrMessage', (event) => {
        if (generation !== this.generation) return;
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
      if (generation !== this.generation) {
        await native.stopHerdrBridge(started.bridgeId);
        throw new ConnectionError('ERR_BRIDGE_CLOSED', 'Bridge connection was cancelled.');
      }
      this.bridgeId = started.bridgeId;
      const hello = bridgeHelloSchema.parse(JSON.parse(started.hello));
      if (hello.fatal) {
        throw new HerdrBridgeRequestError(
          hello.error?.code ?? 'BRIDGE_CONFIGURATION', hello.error?.message ?? hello.warning ?? 'The bridge needs attention.',
        );
      }
      if (hello.runtimeReady === false) {
        throw new ConnectionError('HERDR_UNAVAILABLE', hello.error?.message ?? 'Herdr is unavailable.');
      }
      for (const event of this.bufferedMessages) {
        if (event.bridgeId === this.bridgeId) {
          this.publish(event.message);
        }
      }
      this.bufferedMessages = [];
      return hello;
    } catch (error) {
      try {
        if (generation === this.generation) await this.stop();
      } catch (cleanupError) {
        console.warn('[HERDR_BRIDGE] Could not clean up failed bridge start', cleanupError);
      }
      throw error;
    }
  }

  subscribe(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request<T>(
    action: string,
    payload: Record<string, unknown>,
    commandId?: string,
  ): Promise<T> {
    if (!this.bridgeId) {
      throw new HerdrBridgeRequestError('BRIDGE_NOT_STARTED', 'Herdr bridge is not running.');
    }
    const generation = this.generation;
    const id = createId();
    const request = JSON.stringify({
      protocol: 1,
      id,
      type: 'request',
      action,
      payload,
      ...(commandId ? { commandId } : {}),
    });
    const raw = await getRemoteCoreNativeModule().requestHerdrBridge(
      this.bridgeId,
      request,
    );
    const response = bridgeResponseSchema.parse(JSON.parse(raw));
    if (generation !== this.generation) {
      throw new ConnectionError('ERR_BRIDGE_CLOSED', 'Response belongs to a closed connection.');
    }
    if (response.id !== id) {
      throw new ConnectionError('INVALID_RESPONSE', 'Bridge response ID does not match the request.');
    }
    if (!response.ok) {
      throw new HerdrBridgeRequestError(
        response.error?.code ?? 'BRIDGE_ERROR',
        response.error?.message ?? 'Herdr request failed.',
      );
    }
    return response.payload as T;
  }

  async stop(): Promise<void> {
    this.generation++;
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
