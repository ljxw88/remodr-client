import { z } from 'zod';

export const AUTH_TYPES = ['password', 'privateKey'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

export interface HostProfile {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  authType: AuthType;
  credentialId?: string;
  favorite?: boolean;
  group?: string;
  jumpHostIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateHostInput {
  name: string;
  hostname: string;
  port: number;
  username: string;
  authType: AuthType;
  credentialId?: string;
  favorite?: boolean;
  group?: string;
  jumpHostIds?: string[];
}

export type UpdateHostInput = CreateHostInput;

export interface HostRepository {
  list(): Promise<HostProfile[]>;
  get(id: string): Promise<HostProfile | null>;
  create(input: CreateHostInput): Promise<HostProfile>;
  update(id: string, input: UpdateHostInput): Promise<HostProfile>;
  remove(id: string): Promise<void>;
}

export class HostNotFoundError extends Error {
  readonly hostId: string;

  constructor(hostId: string) {
    super('Host not found');
    this.name = 'HostNotFoundError';
    this.hostId = hostId;
  }
}

export const authTypeSchema = z.enum(AUTH_TYPES);

export const createHostInputSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  hostname: z.string().trim().min(1, 'Hostname is required'),
  port: z
    .number({ error: 'Port must be a number' })
    .int('Port must be a whole number')
    .min(1, 'Port must be between 1 and 65535')
    .max(65535, 'Port must be between 1 and 65535'),
  username: z.string().trim().min(1, 'Username is required'),
  authType: authTypeSchema,
  credentialId: z.string().min(1).optional(),
  favorite: z.boolean().optional(),
  group: z.string().trim().optional(),
  jumpHostIds: z.array(z.string().min(1)).optional(),
});

export const hostProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  hostname: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  authType: authTypeSchema,
  credentialId: z.string().min(1).optional(),
  favorite: z.boolean().optional(),
  group: z.string().optional(),
  jumpHostIds: z.array(z.string().min(1)).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const storedHostsSchema = z.object({
  version: z.literal(1),
  hosts: z.array(z.unknown()),
});

export type HostFormFields = {
  name: string;
  hostname: string;
  port: string;
  username: string;
  authType: AuthType;
};

export type HostFieldErrors = Partial<Record<keyof HostFormFields, string>>;

export const DEFAULT_HOST_FORM: HostFormFields = {
  name: '',
  hostname: '',
  port: '22',
  username: '',
  authType: 'password',
};

export const hostFormSchema = z.object({
  name: z.string().trim().min(1, 'Name is required'),
  hostname: z.string().trim().min(1, 'Hostname is required'),
  port: z
    .string()
    .trim()
    .min(1, 'Port is required')
    .regex(/^\d+$/, 'Port must be a number')
    .transform((value) => Number(value))
    .refine((port) => port >= 1 && port <= 65535, 'Port must be between 1 and 65535'),
  username: z.string().trim().min(1, 'Username is required'),
  authType: authTypeSchema,
});

export function parseHostForm(
  fields: HostFormFields,
): { ok: true; data: CreateHostInput } | { ok: false; fieldErrors: HostFieldErrors } {
  const result = hostFormSchema.safeParse(fields);
  if (result.success) {
    return { ok: true, data: result.data };
  }

  const fieldErrors: HostFieldErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && fieldErrors[key as keyof HostFormFields] == null) {
      fieldErrors[key as keyof HostFormFields] = issue.message;
    }
  }
  return { ok: false, fieldErrors };
}

export function hostFormFromProfile(host: HostProfile): HostFormFields {
  return {
    name: host.name,
    hostname: host.hostname,
    port: String(host.port),
    username: host.username,
    authType: host.authType,
  };
}

export function decodeHostRecords(raw: string | null): HostProfile[] {
  if (!raw) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const envelope = storedHostsSchema.safeParse(parsed);
  if (!envelope.success) {
    return [];
  }

  return envelope.data.hosts.flatMap((item) => {
    const host = hostProfileSchema.safeParse(item);
    return host.success ? [host.data] : [];
  });
}

export function encodeHostRecords(hosts: HostProfile[]): string {
  const sanitized = hosts.map((host) => hostProfileSchema.parse(host));
  return JSON.stringify({ version: 1, hosts: sanitized });
}
