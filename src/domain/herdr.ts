import { z } from 'zod';

export const agentProviderSchema = z.enum([
  'copilot',
  'claude',
  'codex',
  'opencode',
  'unknown',
]);
export type AgentProvider = z.infer<typeof agentProviderSchema>;

export const agentStatusSchema = z.enum([
  'working',
  'blocked',
  'done',
  'idle',
  'unknown',
]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const agentCapabilitiesSchema = z.object({
  structuredConversation: z.boolean().default(false),
  streamingConversation: z.boolean().default(false),
  structuredQuestions: z.boolean().default(false),
  toolActivity: z.boolean().default(false),
  todos: z.boolean().default(false),
  fallback: z.boolean().default(true),
});

export const remoteAgentSchema = z.object({
  id: z.string(),
  provider: agentProviderSchema,
  providerSessionId: z.string().nullable().optional(),
  herdrSessionId: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  tabId: z.string().nullable().optional(),
  paneId: z.string(),
  cwd: z.string().nullable().optional(),
  status: agentStatusSchema,
  title: z.string(),
  focused: z.boolean(),
  capabilities: agentCapabilitiesSchema,
});
export type RemoteAgent = z.infer<typeof remoteAgentSchema>;

export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: agentStatusSchema,
});
export type AgentWorkspace = z.infer<typeof workspaceSchema>;

export const herdrConnectionStateSchema = z.enum([
  'disconnected',
  'connecting',
  'authenticating',
  'starting_bridge',
  'synchronizing',
  'connected',
  'reconnecting',
  'error',
]);
export type HerdrConnectionState = z.infer<typeof herdrConnectionStateSchema>;

export const runtimeStateSchema = z.object({
  connectionState: herdrConnectionStateSchema,
  herdrVersion: z.string().optional(),
  herdrProtocol: z.number().optional(),
  herdrSession: z.string().optional(),
  socketPath: z.string().optional(),
  workspaces: z.array(workspaceSchema),
  agents: z.array(remoteAgentSchema),
  lastRuntimeEvent: z.number().optional(),
});
export type HerdrRuntimeState = z.infer<typeof runtimeStateSchema>;

export const humanOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
export type HumanOption = z.infer<typeof humanOptionSchema>;

export const humanRequestSchema = z.object({
  id: z.string(),
  kind: z.enum(['choice', 'text', 'confirmation', 'permission']),
  question: z.string(),
  options: z.array(humanOptionSchema).default([]),
  allowCustomAnswer: z.boolean().default(true),
  multiSelect: z.boolean().default(false),
});
export type HumanRequest = z.infer<typeof humanRequestSchema>;

const conversationBaseSchema = z.object({
  id: z.string(),
  timestamp: z.union([z.string(), z.number()]).nullable().optional(),
});

export const conversationItemSchema = z.discriminatedUnion('kind', [
  conversationBaseSchema.extend({
    kind: z.literal('user_message'),
    text: z.string(),
  }),
  conversationBaseSchema.extend({
    kind: z.literal('assistant_message'),
    markdown: z.string(),
  }),
  conversationBaseSchema.extend({
    kind: z.literal('tool_activity'),
    tool: z.string().optional(),
    title: z.string(),
    detail: z.string().nullable().optional(),
    state: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled', 'unknown']),
  }),
  conversationBaseSchema.extend({
    kind: z.literal('human_request'),
    request: humanRequestSchema,
    resolved: z.boolean().optional(),
  }),
  conversationBaseSchema.extend({
    kind: z.literal('status_notice'),
    status: agentStatusSchema,
    text: z.string().nullable().optional(),
  }),
  conversationBaseSchema.extend({
    kind: z.literal('todo_update'),
    todos: z.array(
      z.object({
        id: z.string().nullable().optional(),
        text: z.string(),
        state: z.enum(['pending', 'in_progress', 'done', 'blocked', 'unknown']),
      }),
    ),
  }),
  conversationBaseSchema.extend({
    kind: z.literal('raw_output'),
    text: z.string(),
  }),
]);
export type ConversationItem = z.infer<typeof conversationItemSchema>;

export const conversationSchema = z.object({
  agentId: z.string(),
  provider: agentProviderSchema,
  semantic: z.boolean(),
  items: z.array(conversationItemSchema),
  activeHumanRequest: humanRequestSchema.nullable().optional(),
});
export type AgentConversation = z.infer<typeof conversationSchema>;

export const bridgeHelloSchema = z.object({
  protocol: z.literal(1),
  type: z.literal('hello'),
  bridgeVersion: z.string(),
  herdrVersion: z.string(),
  herdrProtocol: z.number(),
  capabilities: z.record(z.string(), z.unknown()),
  warning: z.string().optional(),
});
export type BridgeHello = z.infer<typeof bridgeHelloSchema>;

export const bridgeResponseSchema = z.object({
  protocol: z.literal(1),
  id: z.string().nullable(),
  type: z.literal('response'),
  ok: z.boolean(),
  payload: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export const bridgeEventSchema = z.object({
  protocol: z.literal(1),
  type: z.literal('event'),
  event: z.string(),
  data: z.unknown(),
});
export type BridgeEvent = z.infer<typeof bridgeEventSchema>;

export const EMPTY_RUNTIME: HerdrRuntimeState = {
  connectionState: 'disconnected',
  workspaces: [],
  agents: [],
};

export function providerLabel(provider: AgentProvider): string {
  switch (provider) {
    case 'copilot':
      return 'GitHub Copilot';
    case 'claude':
      return 'Claude Code';
    case 'codex':
      return 'Codex';
    case 'opencode':
      return 'OpenCode';
    default:
      return 'Agent';
  }
}

export function statusLabel(status: AgentStatus): string {
  switch (status) {
    case 'working':
      return 'Working';
    case 'blocked':
      return 'Needs input';
    case 'done':
      return 'Done';
    case 'idle':
      return 'Idle';
    default:
      return 'Unknown';
  }
}
