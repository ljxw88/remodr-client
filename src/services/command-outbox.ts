import AsyncStorage from '@react-native-async-storage/async-storage';
import { z } from 'zod';
import { randomUUID } from 'expo-crypto';
import { commandSession, sameAgentSession } from '@/domain/agent-session';

const KEY = 'remote-workspace.commands.v1';
const MAX_PENDING = 200;
const commandSchema = z.object({
  id: z.string(),
  deviceId: z.string(),
  agentId: z.string(),
  action: z.enum(['agent.send_message', 'human_request.answer', 'agent.interrupt']),
  payload: z.record(z.string(), z.unknown()),
  text: z.string(),
  createdAt: z.number(),
  state: z.enum(['queued', 'sending', 'sent', 'failed', 'uncertain']),
  error: z.string().nullable(),
  baselineIds: z.array(z.string()),
  attempted: z.boolean(),
  invalidated: z.boolean().default(false),
});
export type PendingCommand = z.infer<typeof commandSchema>;
type NewCommand = Pick<PendingCommand, 'deviceId' | 'agentId' | 'action' | 'payload' | 'text' | 'baselineIds'>;
type Store = Pick<typeof AsyncStorage, 'getItem' | 'setItem'>;

/**
 * Writes are serialized and committed before publishing UI state. A failed write
 * leaves the previous durable state intact; callers must not clear the draft.
 */
export class CommandOutbox {
  private commands: readonly PendingCommand[] = [];
  private listeners = new Set<() => void>();
  private writing: Promise<unknown> = Promise.resolve();
  private hydration: Promise<void> | null = null;

  constructor(private readonly store: Store = AsyncStorage) {}

  getSnapshot = (): readonly PendingCommand[] => this.commands;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  hydrate(): Promise<void> {
    if (!this.hydration) {
      this.hydration = this.exclusive(async () => {
        const raw = await this.store.getItem(KEY);
        const parsed = raw ? z.array(commandSchema).parse(JSON.parse(raw)) : [];
        await this.commit(parsed.map((command) => {
          if (command.action === 'agent.interrupt' && ['queued', 'sending'].includes(command.state)) {
            return { ...command, state: command.attempted ? 'uncertain' : 'failed', invalidated: true,
              error: 'The connection changed. This interrupt will not be sent to a later run.' };
          }
          return command.state === 'sending' ? { ...command, state: 'queued', error: null } : command;
        }));
      }).catch((error) => {
        this.hydration = null;
        throw error;
      });
    }
    return this.hydration;
  }

  async enqueue(input: NewCommand): Promise<PendingCommand> {
    await this.hydrate();
    return this.exclusive(async () => {
      if (input.action === 'human_request.answer' && this.commands.some((entry) =>
        entry.deviceId === input.deviceId && entry.agentId === input.agentId && entry.action === input.action &&
        sameAgentSession(commandSession(entry.payload), commandSession(input.payload)) &&
        entry.payload.requestId === input.payload.requestId,
      )) {
        throw new Error('An answer to this question is already queued. Review it before submitting another.');
      }
      if (this.commands.length >= MAX_PENDING) {
        throw new Error('The send queue is full. Review pending messages before adding more.');
      }
      const command: PendingCommand = {
        ...input, id: randomUUID(), createdAt: Date.now(), state: 'queued', error: null, attempted: false, invalidated: false,
      };
      await this.commit([...this.commands, command]);
      return command;
    });
  }

  async update(id: string, patch: Partial<Pick<PendingCommand, 'state' | 'error' | 'attempted' | 'invalidated'>>) {
    await this.hydrate();
    await this.exclusive(() => this.commit(
      this.commands.map((command) => command.id === id && (!command.invalidated || patch.invalidated)
        ? { ...command, ...patch } : command),
    ));
  }

  async remove(id: string) {
    await this.hydrate();
    await this.exclusive(() => this.commit(this.commands.filter((command) => command.id !== id)));
  }

  async discard(id: string) {
    await this.hydrate();
    await this.exclusive(async () => {
      if (this.commands.find((entry) => entry.id === id)?.state === 'sending') {
        throw new Error('Wait for delivery to finish before removing this message.');
      }
      await this.commit(this.commands.filter((entry) => entry.id !== id));
    });
  }

  async claim(id: string): Promise<PendingCommand | null> {
    await this.hydrate();
    return this.exclusive(async () => {
      const command = this.commands.find((entry) => entry.id === id);
      if (!command || command.invalidated || command.state !== 'queued') return null;
      const claimed = { ...command, state: 'sending' as const, attempted: true, error: null };
      await this.commit(this.commands.map((entry) => entry.id === id ? claimed : entry));
      return claimed;
    });
  }

  async removeAgent(agentId: string) {
    await this.hydrate();
    await this.exclusive(() => this.commit(this.commands.filter((command) => command.agentId !== agentId)));
  }

  async reconcile(id: string, remoteId: string) {
    await this.hydrate();
    await this.exclusive(async () => {
      const matched = this.commands.find((entry) => entry.id === id);
      if (!matched) return;
      await this.commit(this.commands.filter((entry) => entry.id !== id).map((entry) =>
        entry.deviceId === matched.deviceId && entry.agentId === matched.agentId &&
        sameAgentSession(commandSession(entry.payload), commandSession(matched.payload)) &&
        !entry.baselineIds.includes(remoteId)
          ? { ...entry, baselineIds: [...entry.baselineIds, remoteId] } : entry,
      ));
    });
  }

  async setBaseline(id: string, baselineIds: string[]) {
    await this.hydrate();
    await this.exclusive(() => this.commit(this.commands.map((entry) =>
      entry.id === id && !entry.attempted ? { ...entry, baselineIds } : entry,
    )));
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.writing.then(work);
    // Keep the writer usable after an error, but return that error to its caller.
    this.writing = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async commit(commands: readonly PendingCommand[]) {
    await this.store.setItem(KEY, JSON.stringify(commands));
    this.commands = commands;
    this.listeners.forEach((listener) => listener());
  }
}
