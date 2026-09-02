import {
  createHostInputSchema,
  decodeHostRecords,
  encodeHostRecords,
  HostNotFoundError,
  type CreateHostInput,
  type HostProfile,
  type HostRepository,
  type UpdateHostInput,
} from '@/domain/hosts';
import { createId } from '@/utils/create-id';

export const HOSTS_STORAGE_KEY = 'remote-workspace.hosts.v1';

export interface StringStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export function createMemoryStringStore(initial: Record<string, string> = {}): StringStore {
  const data: Record<string, string> = { ...initial };
  return {
    async getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    async setItem(key: string, value: string) {
      data[key] = value;
    },
  };
}

export class JsonHostRepository implements HostRepository {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: StringStore,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = createId,
  ) {}

  async list(): Promise<HostProfile[]> {
    await this.mutationTail;
    const hosts = await this.readAll();
    return [...hosts].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<HostProfile | null> {
    await this.mutationTail;
    const hosts = await this.readAll();
    return hosts.find((host) => host.id === id) ?? null;
  }

  async create(input: CreateHostInput): Promise<HostProfile> {
    const data = createHostInputSchema.parse(input);
    return this.enqueueMutation(async () => {
      const hosts = await this.readAll();
      const timestamp = this.now().toISOString();
      const host: HostProfile = {
        ...data,
        id: this.newId(),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      hosts.push(host);
      await this.writeAll(hosts);
      return host;
    });
  }

  async update(id: string, input: UpdateHostInput): Promise<HostProfile> {
    const data = createHostInputSchema.parse(input);
    return this.enqueueMutation(async () => {
      const hosts = await this.readAll();
      const index = hosts.findIndex((host) => host.id === id);
      if (index === -1) {
        throw new HostNotFoundError(id);
      }

      const current = hosts[index];
      const updated: HostProfile = {
        ...current,
        ...data,
        credentialId:
          data.authType === current.authType ? data.credentialId ?? current.credentialId : undefined,
        id: current.id,
        createdAt: current.createdAt,
        updatedAt: this.now().toISOString(),
      };
      hosts[index] = updated;
      await this.writeAll(hosts);
      return updated;
    });
  }

  async remove(id: string): Promise<void> {
    await this.enqueueMutation(async () => {
      const hosts = await this.readAll();
      const next = hosts.filter((host) => host.id !== id);
      if (next.length === hosts.length) {
        throw new HostNotFoundError(id);
      }
      await this.writeAll(next);
    });
  }

  private async readAll(): Promise<HostProfile[]> {
    return decodeHostRecords(await this.store.getItem(HOSTS_STORAGE_KEY));
  }

  private async writeAll(hosts: HostProfile[]): Promise<void> {
    await this.store.setItem(HOSTS_STORAGE_KEY, encodeHostRecords(hosts));
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
