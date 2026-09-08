import { z } from 'zod';
import { contextTierSchema, reasoningEffortSchema } from '@/domain/model-catalogue-schema';

export { contextTierSchema, reasoningEffortSchema } from '@/domain/model-catalogue-schema';

export const launchableAgentProviderSchema = z.enum([
  'opencode',
  'copilot',
]);
export type LaunchableAgentProvider = z.infer<typeof launchableAgentProviderSchema>;

// Older/newer bridges may report providers this app cannot launch.
export const agentProviderSchema = z.string().min(1).pipe(
  z.union([launchableAgentProviderSchema, z.literal('unknown')]).catch('unknown'),
);
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
  /** Older bridges omit this field; absence is not an explicit refusal. */
  supportsRetuning: z.boolean().optional(),
  structuredConversation: z.boolean().default(false),
  streamingConversation: z.boolean().default(false),
  structuredQuestions: z.boolean().default(false),
  toolActivity: z.boolean().default(false),
  todos: z.boolean().default(false),
  fallback: z.boolean().default(true),
});

/**
 * What an agent is running, as far as the bridge can tell.
 *
 * The reasoning and context vocabularies are the CLI's, not ours, and it can
 * add to them whenever it updates. An unrecognised one reads as nothing rather
 * than failing: this sits inside the agent list, and a strict parse would take
 * every agent off the screen because one of them was running a setting this
 * build had not heard of.
 */
export const agentTuningSchema = z.object({
  model: z.string().nullable().default(null),
  effort: reasoningEffortSchema.nullable().catch(null).default(null),
  context: contextTierSchema.nullable().catch(null).default(null),
});
export type AgentTuning = z.infer<typeof agentTuningSchema>;

export const agentCompletionSchema = z.object({
  id: z.string().min(1),
  unread: z.boolean(),
  statusRevision: z.number().int().nonnegative().nullable().default(null),
});
export type AgentCompletion = z.infer<typeof agentCompletionSchema>;

export const remoteAgentSchema = z.object({
  id: z.string(),
  deviceId: z.string().optional(),
  provider: agentProviderSchema,
  providerSessionId: z.string().nullable().optional(),
  herdrSessionId: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  tabId: z.string().nullable().optional(),
  paneId: z.string(),
  cwd: z.string().nullable().optional(),
  status: agentStatusSchema,
  statusRevision: z.number().int().nonnegative().nullable().catch(null).optional(),
  /** Client-owned completion receipt and last server-observed status. */
  observedStatus: agentStatusSchema.optional().catch(undefined),
  completion: agentCompletionSchema.optional().catch(undefined),
  title: z.string(),
  focused: z.boolean(),
  capabilities: agentCapabilitiesSchema,
  tuning: agentTuningSchema.optional(),
  /** Unix milliseconds of observed output activity, not snapshot receipt time. */
  lastOutputAt: z.number().int().nonnegative().nullable().catch(null).optional(),
});
export type RemoteAgent = z.infer<typeof remoteAgentSchema>;

export const workspaceSchema = z.object({
  id: z.string(),
  deviceId: z.string().optional(),
  name: z.string(),
  cwd: z.string().nullable().optional(),
  paneCount: z.number().int().nonnegative().optional(),
  status: agentStatusSchema,
});
export type AgentWorkspace = z.infer<typeof workspaceSchema>;

export const agentManifestSchema = z.object({
  provider: z.string().min(1),
  available: z.boolean(),
  aliases: z.array(z.string()).default([]),
  unavailableReason: z.string().nullable().optional(),
}).transform((manifest) => {
  const provider = agentProviderSchema.parse(manifest.provider);
  return provider === 'unknown' ? {
    ...manifest,
    provider,
    available: false,
    unavailableReason: manifest.unavailableReason
      ?? `This app does not support the provider "${manifest.provider}" reported by the bridge.`,
  } : { ...manifest, provider };
});
export type AgentManifest = z.infer<typeof agentManifestSchema>;

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

export function isRuntimeLoading(connection: HerdrConnectionState): boolean {
  return connection === 'connecting' || connection === 'authenticating' ||
    connection === 'starting_bridge' || connection === 'synchronizing' || connection === 'reconnecting';
}

export const runtimeStateSchema = z.object({
  connectionState: herdrConnectionStateSchema,
  deviceId: z.string().optional(),
  herdrVersion: z.string().optional(),
  herdrProtocol: z.number().optional(),
  herdrSession: z.string().optional(),
  socketPath: z.string().optional(),
  workspaces: z.array(workspaceSchema),
  agents: z.array(remoteAgentSchema),
  providers: z.array(agentManifestSchema).default([]),
  lastRuntimeEvent: z.number().optional(),
  runtimeRevision: z.number().int().nonnegative().optional(),
});
export type HerdrRuntimeState = z.infer<typeof runtimeStateSchema>;

export const deviceAgentCountsSchema = z.record(
  z.string(),
  z.number().int().nonnegative(),
);
export type DeviceAgentCounts = z.infer<typeof deviceAgentCountsSchema>;

export function totalDeviceAgentCount(counts: DeviceAgentCounts): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

export const reasoningVariantSchema = z.string().min(1).max(128).refine(
  (value) => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value),
  'Variant names cannot contain control characters or surrounding whitespace',
);

export const agentVariantOptionsSchema = z.object({
  modelLabel: z.string().min(1).max(512),
  modelToken: z.string().min(1).max(1024),
  currentVariant: reasoningVariantSchema.nullable(),
  variants: z.array(reasoningVariantSchema).max(128),
}).superRefine((options, ctx) => {
  if (new Set(options.variants).size !== options.variants.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate variant choices' });
  }
  if (options.currentVariant !== null && !options.variants.includes(options.currentVariant)) {
    ctx.addIssue({ code: 'custom', message: 'Current variant is not in the available choices' });
  }
});
export type AgentVariantOptions = z.infer<typeof agentVariantOptionsSchema>;

export const retuneAgentInputSchema = z.object({
  agentId: z.string().min(1),
  model: z.string().trim().nullable().optional(),
  effort: reasoningEffortSchema.nullable().optional(),
  context: contextTierSchema.nullable().optional(),
  /** OpenCode variant IDs are model-specific, not portable reasoning efforts. */
  variant: reasoningVariantSchema.nullable().optional(),
  modelToken: z.string().min(1).max(1024).optional(),
  providerSessionId: z.string().min(1).optional(),
});
export type RetuneAgentInput = z.infer<typeof retuneAgentInputSchema>;

export const createAgentInputSchema = z.object({
  provider: launchableAgentProviderSchema,
  workspaceId: z.string().min(1),
  bypassPermissions: z.boolean().default(true),
  /** Becomes the agent's title, so it can be picked out of a list. */
  name: z.string().trim().max(60).optional(),
  /** Left off to let the CLI choose, which is the only always-available one. */
  model: z.string().trim().optional(),
  effort: reasoningEffortSchema.optional(),
  context: contextTierSchema.optional(),
});
export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;

export const createAgentResultSchema = z.object({
  paneId: z.string(),
  agentId: z.string().nullable().optional(),
  name: z.string(),
  runtime: runtimeStateSchema,
});
export type CreateAgentResult = z.infer<typeof createAgentResultSchema>;

export const renameAgentInputSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().trim().min(1, 'A name is required').max(60),
});
export type RenameAgentInput = z.infer<typeof renameAgentInputSchema>;

export const agentMutationResultSchema = z.object({
  agentId: z.string(),
  runtime: runtimeStateSchema,
});
export type AgentMutationResult = z.infer<typeof agentMutationResultSchema>;

export const createSpaceInputSchema = z.object({
  cwd: z.string().trim().min(1, 'Root folder is required'),
  label: z.string().trim().optional(),
});
export type CreateSpaceInput = z.infer<typeof createSpaceInputSchema>;

export const createSpaceResultSchema = z.object({
  workspaceId: z.string(),
  runtime: runtimeStateSchema,
});
export type CreateSpaceResult = z.infer<typeof createSpaceResultSchema>;

export const closeSpaceInputSchema = z.object({
  workspaceId: z.string().min(1),
  closeGroup: z.boolean().default(false),
});
export type CloseSpaceInput = z.infer<typeof closeSpaceInputSchema>;

export const closeSpaceResultSchema = createSpaceResultSchema;
export type CloseSpaceResult = z.infer<typeof closeSpaceResultSchema>;

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
    commandId: z.string().optional(),
    delivery: z.enum(['queued', 'sending', 'sent', 'failed', 'uncertain']).optional(),
    deliveryError: z.string().optional(),
    previousSession: z.boolean().optional(),
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
        state: z.enum(['pending', 'in_progress', 'done', 'blocked', 'cancelled', 'unknown']),
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
  /** Absent only on older bridges/cache entries that did not identify the session read. */
  providerSessionId: z.string().nullable().optional(),
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
  herdrProtocol: z.number().nullable(),
  capabilities: z.record(z.string(), z.unknown()),
  warning: z.string().optional(),
  runtimeReady: z.boolean().optional(),
  fatal: z.boolean().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
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
  providers: [],
};

export function providerLabel(provider: AgentProvider): string {
  switch (provider) {
    case 'copilot':
      return 'GitHub Copilot';
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
