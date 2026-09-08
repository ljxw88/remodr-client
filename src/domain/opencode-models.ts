import { z } from 'zod';

export const openCodeModelsSchema = z.object({
  workspaceId: z.string().min(1),
  cwd: z.string().min(1),
  models: z.array(z.string().min(3).max(512).regex(/^[^\s/\u0000-\u001f\u007f]+\/[^\s\u0000-\u001f\u007f]+$/)).max(10000),
}).refine((value) => new Set(value.models).size === value.models.length, 'Duplicate OpenCode models');

export type OpenCodeModels = z.infer<typeof openCodeModelsSchema>;
