import { z } from 'zod';

export const reasoningEffortSchema = z.enum([
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
]);
export const contextTierSchema = z.enum(['default', 'long_context']);
export const catalogueProviderSchema = z.enum(['copilot', 'codex', 'claude', 'cursor']);
const providerEfforts: Record<z.infer<typeof catalogueProviderSchema>, readonly string[]> = {
  copilot: reasoningEffortSchema.options.filter((effort) => effort !== 'ultra'),
  codex: reasoningEffortSchema.options,
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  cursor: [],
};

export const modelSpecSchema = z.object({
  id: z.string().trim().min(1).refine(
    (id) => ![...id].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127),
    'Model IDs cannot contain control characters',
  ),
  label: z.string().trim().min(1),
  efforts: z.array(reasoningEffortSchema),
  contexts: z.array(z.object({
    tier: contextTierSchema,
    size: z.string().regex(/^\d+(\.\d+)?[KM]$/),
  })),
  limits: z.object({
    contextTokens: z.number().int().positive().nullable(),
    outputTokens: z.number().int().positive().nullable(),
  }),
  defaultEffort: reasoningEffortSchema.nullable(),
  // Keep provider-specific capabilities without making them portable CLI flags.
  details: z.record(z.string(), z.unknown()),
}).strict().superRefine((model, ctx) => {
  if (new Set(model.efforts).size !== model.efforts.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate reasoning efforts' });
  }
  if (model.defaultEffort !== null && !model.efforts.includes(model.defaultEffort)) {
    ctx.addIssue({ code: 'custom', message: 'Default effort must be supported' });
  }
  const tiers = model.contexts.map((context) => context.tier);
  if (model.contexts.length === 1 || new Set(tiers).size !== tiers.length) {
    ctx.addIssue({ code: 'custom', message: 'Context choices must contain two distinct tiers or be empty' });
  }
});

export const modelCatalogueSchema = z.object({
  schemaVersion: z.literal(1),
  provider: catalogueProviderSchema,
  updatedAt: z.iso.datetime().nullable(),
  sources: z.array(z.object({
    kind: z.enum(['cli', 'api', 'repository', 'manual']),
    location: z.string().min(1),
  }).strict()).min(1),
  notes: z.array(z.string()),
  unavailableReason: z.string().min(1).optional(),
  models: z.array(modelSpecSchema),
}).strict().superRefine((catalogue, ctx) => {
  if (!catalogue.models.length && (!catalogue.unavailableReason || catalogue.updatedAt !== null)) {
    ctx.addIssue({ code: 'custom', message: 'An empty catalogue requires an explicit unrefreshed/unavailable reason' });
  }
  if (catalogue.models.length && catalogue.unavailableReason) {
    ctx.addIssue({ code: 'custom', message: 'A populated catalogue cannot be marked unavailable' });
  }
  for (const model of catalogue.models) {
    if (model.efforts.some((effort) => !providerEfforts[catalogue.provider].includes(effort))) {
      ctx.addIssue({ code: 'custom', message: `${catalogue.provider}: effort is not supported by the bridge` });
    }
    if (catalogue.provider !== 'copilot' && model.contexts.length) {
      ctx.addIssue({ code: 'custom', message: `${catalogue.provider}: separate context tiers are not supported by the bridge` });
    }
  }
  const ids = catalogue.models.map((model) => model.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate model IDs' });
  }
});

export type ModelSpec = z.infer<typeof modelSpecSchema>;
export type ModelCatalogue = z.infer<typeof modelCatalogueSchema>;
