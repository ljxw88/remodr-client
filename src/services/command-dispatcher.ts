import { agentSession, commandSession, conversationMatchesAgent, sameAgentSession } from '@/domain/agent-session';
import { classifyConnectionError, connectionErrorCode } from '@/domain/connection-error';
import type { AgentConversation, RemoteAgent } from '@/domain/herdr';
import { CommandOutbox, type PendingCommand } from './command-outbox';

export interface CommandAttachment {
  isCurrent(): boolean;
  supportsDurableCommands(): boolean;
  send(command: PendingCommand): Promise<unknown>;
}

export interface CommandDispatchSource {
  open(deviceId: string): CommandAttachment | null;
  isConnected(deviceId: string): boolean;
  getAgent(agentId: string): RemoteAgent | undefined;
  getConversation(agentId: string): AgentConversation | null;
  readConversation(agentId: string): Promise<AgentConversation>;
  reconnect(deviceId: string): Promise<boolean> | undefined;
  onSent(agentId: string): void;
  onConnectionError(deviceId: string, error: unknown): void;
  onQueueError(deviceId: string): void;
}

type NewCommand = Parameters<CommandOutbox['enqueue']>[0] & {
  action: Exclude<PendingCommand['action'], 'agent.interrupt'>;
};

/** Owns delivery policy and timers; CommandOutbox remains the durable state owner. */
export class CommandDispatcher {
  private draining = new Map<string, Promise<void>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly outbox: CommandOutbox, private readonly source: CommandDispatchSource) {}

  getSnapshot = () => this.outbox.getSnapshot();
  subscribe = (listener: () => void) => this.outbox.subscribe(listener);
  hydrate = () => this.outbox.hydrate();
  discard = (id: string) => this.outbox.discard(id);

  async enqueue(command: NewCommand): Promise<void> {
    await this.outbox.enqueue(command);
    if (this.source.isConnected(command.deviceId)) this.schedule(command.deviceId);
    else {
      // Join recovery without treating an offline enqueue as a failed attachment.
      void this.source.reconnect(command.deviceId)?.catch((error) => {
        console.warn('[CONNECTION] Queued message is waiting for recovery', error);
      });
    }
  }

  async detach(deviceId: string): Promise<void> {
    this.cancelTimer(deviceId);
    await this.outbox.hydrate();
    for (const command of this.outbox.getSnapshot()) {
      if (command.deviceId === deviceId && command.action === 'agent.interrupt'
        && ['queued', 'sending'].includes(command.state)) {
        await this.outbox.update(command.id, {
          state: command.attempted ? 'uncertain' : 'failed', invalidated: true,
          error: 'The connection changed. This interrupt will not be sent to a later run.',
        });
      }
    }
  }

  flush(deviceId: string): Promise<void> {
    this.cancelTimer(deviceId);
    const active = this.draining.get(deviceId);
    if (active) return active;
    const attempt = (async () => {
      await this.outbox.hydrate();
      // Recover a failed local ACK write using the existing durable command ID.
      for (const command of this.outbox.getSnapshot()) {
        if (command.deviceId === deviceId && command.state === 'sending') {
          await this.outbox.update(command.id, {
            state: command.action === 'agent.interrupt' ? 'uncertain' : 'queued',
          });
        }
      }
      await this.drain(deviceId);
    })().finally(() => {
      if (this.draining.get(deviceId) === attempt) this.draining.delete(deviceId);
      if (this.source.isConnected(deviceId) && this.outbox.getSnapshot().some((command) =>
        command.deviceId === deviceId && (command.state === 'queued' || command.state === 'sending'),
      )) this.schedule(deviceId, 5000);
    });
    this.draining.set(deviceId, attempt);
    return attempt;
  }

  private cancelTimer(deviceId: string) {
    clearTimeout(this.timers.get(deviceId));
    this.timers.delete(deviceId);
  }

  private schedule(deviceId: string, delay = 0) {
    if (this.timers.has(deviceId)) return;
    this.timers.set(deviceId, setTimeout(() => {
      this.timers.delete(deviceId);
      void this.flush(deviceId).catch((error) => {
        console.warn('[OUTBOX] Could not process persisted commands', error);
        this.source.onQueueError(deviceId);
      });
    }, delay));
  }

  private async drain(deviceId: string): Promise<void> {
    await this.outbox.hydrate();
    const attachment = this.source.open(deviceId);
    if (!attachment) return;
    const connected = () => attachment.isCurrent() && this.source.isConnected(deviceId);
    while (connected()) {
      const commands = this.outbox.getSnapshot().filter((entry) => entry.deviceId === deviceId);
      const uncertain = commands.filter((entry) => entry.state === 'uncertain');
      const command = commands.find((entry) => entry.state === 'queued' && !entry.invalidated
        && !uncertain.some((blocked) => blocked.agentId === entry.agentId
          && sameAgentSession(commandSession(blocked.payload), commandSession(entry.payload))));
      if (!command) return;
      if (!attachment.supportsDurableCommands()) {
        await this.outbox.update(command.id, { state: 'failed', error: 'Reconnect to update the device bridge.' });
        continue;
      }
      if (Date.now() - command.createdAt > 24 * 60 * 60 * 1000) {
        await this.outbox.update(command.id, {
          state: command.attempted ? 'uncertain' : 'failed', error: 'This queued command has expired. Review the conversation.',
        });
        continue;
      }
      if (command.action === 'agent.interrupt' && command.attempted) {
        await this.outbox.update(command.id, { state: 'uncertain', error: 'Interrupt delivery could not be confirmed.' });
        continue;
      }
      try {
        if (!command.attempted) {
          // Only an authoritative read can establish the first-send echo baseline.
          await this.source.readConversation(command.agentId);
          if (!sameAgentSession(commandSession(command.payload), agentSession(this.source.getAgent(command.agentId)))) {
            await this.outbox.update(command.id, {
              state: 'failed', invalidated: true,
              error: 'The agent session changed. This message was not sent to the new session.',
            });
            continue;
          }
          await this.outbox.setBaseline(command.id,
            (this.source.getConversation(command.agentId)?.items ?? []).map((item) => item.id));
        }
        if (!connected()) return;
        const claimed = await this.outbox.claim(command.id);
        if (!claimed) continue;
        if (!connected()) {
          await this.outbox.update(command.id, {
            state: command.action === 'agent.interrupt' ? 'failed' : 'queued',
            invalidated: command.action === 'agent.interrupt',
          });
          return;
        }
        if (!command.attempted
          && !sameAgentSession(commandSession(claimed.payload), agentSession(this.source.getAgent(command.agentId)))) {
          await this.outbox.update(command.id, {
            state: 'failed', invalidated: true,
            error: 'The agent session changed before dispatch. This message was not sent to the new session.',
          });
          continue;
        }
        await attachment.send(claimed);
        await this.outbox.update(command.id, { state: 'sent', error: null });
        if (command.action !== 'agent.interrupt') this.source.onSent(command.agentId);
        if (command.action === 'agent.interrupt') await this.outbox.remove(command.id);
        // A failed post-ACK refresh must never replay an acknowledged command.
        void this.source.readConversation(command.agentId).catch((error) => {
          console.warn('[CONVERSATION] Will refresh acknowledged command after reconnect', error);
        });
      } catch (error) {
        const code = connectionErrorCode(error);
        if (classifyConnectionError(error).retryable || code === 'COMMAND_IN_PROGRESS') {
          await this.outbox.update(command.id, {
            state: command.action === 'agent.interrupt' ? 'uncertain' : 'queued',
            error: command.action === 'agent.interrupt' ? 'Interrupt delivery could not be confirmed.' : null,
          });
          if (code === 'COMMAND_IN_PROGRESS') this.schedule(deviceId, 2000);
          else if (attachment.isCurrent()) this.source.onConnectionError(deviceId, error);
          return;
        }
        await this.outbox.update(command.id, {
          state: code === 'COMMAND_UNCERTAIN' ? 'uncertain' : 'failed',
          error: error instanceof Error ? error.message : 'The command could not be delivered.',
        });
      }
    }
  }

  async retry(id: string): Promise<void> {
    const command = this.outbox.getSnapshot().find((entry) => entry.id === id);
    if (!command) throw new Error('This command is no longer queued.');
    if (!sameAgentSession(commandSession(command.payload), agentSession(this.source.getAgent(command.agentId)))) {
      throw new Error('This message belongs to a previous session. Compose a new message for the current session.');
    }
    if (command.invalidated) throw new Error('The device configuration changed. Review and compose a new message.');
    if (command.state === 'sending' || command.state === 'sent') return;
    if (command.state === 'uncertain') {
      throw new Error('Delivery is uncertain. Review the conversation before sending another message.');
    }
    await this.outbox.update(id, { state: 'queued', error: null });
    if (this.source.isConnected(command.deviceId)) this.schedule(command.deviceId);
    else await this.source.reconnect(command.deviceId);
  }

  async cancelDevice(deviceId: string): Promise<void> {
    await this.outbox.hydrate();
    for (const command of this.outbox.getSnapshot()) {
      if (command.deviceId !== deviceId || command.state === 'sent') continue;
      await this.outbox.update(command.id, {
        state: command.attempted ? 'uncertain' : 'failed', invalidated: true,
        error: 'Device settings changed. This command will not be sent to the new endpoint.',
      });
    }
  }

  async reconcile(conversation: AgentConversation): Promise<void> {
    const claimed = new Set<string>();
    for (const command of this.outbox.getSnapshot()) {
      if (command.agentId !== conversation.agentId || command.state !== 'sent') continue;
      const agent = this.source.getAgent(conversation.agentId);
      if (!agent || !conversationMatchesAgent(conversation, agent)
        || !sameAgentSession(commandSession(command.payload), agentSession(agent))) continue;
      const match = conversation.items.find((item) => item.kind === 'user_message'
        && item.text === command.text && !command.baselineIds.includes(item.id) && !claimed.has(item.id));
      if (match) {
        claimed.add(match.id);
        await this.outbox.reconcile(command.id, match.id);
      } else if (command.action === 'human_request.answer'
        && conversation.activeHumanRequest?.id !== command.payload.requestId) {
        await this.outbox.remove(command.id);
      }
    }
  }
}
