import { HostNotFoundError } from '@/domain/hosts';
import {
  createMemoryStringStore,
  HOSTS_STORAGE_KEY,
  JsonHostRepository,
} from '@/services/json-host-repository';

const input = {
  name: 'gpu-box',
  hostname: 'gpu01.example.com',
  port: 22,
  username: 'ubuntu',
  authType: 'password' as const,
};

describe('JsonHostRepository', () => {
  function createRepository() {
    const store = createMemoryStringStore();
    const repository = new JsonHostRepository(
      store,
      () => new Date('2026-04-01T12:00:00.000Z'),
      () => 'host_fixed',
    );
    return { store, repository };
  }

  it('creates, lists, updates, and removes hosts', async () => {
    const { repository } = createRepository();

    const created = await repository.create(input);
    expect(created).toMatchObject({
      id: 'host_fixed',
      ...input,
      createdAt: '2026-04-01T12:00:00.000Z',
      updatedAt: '2026-04-01T12:00:00.000Z',
    });

    await expect(repository.list()).resolves.toEqual([created]);
    await expect(repository.get(created.id)).resolves.toEqual(created);

    const updated = await repository.update(created.id, {
      ...input,
      name: 'gpu-box-2',
      port: 2222,
    });
    expect(updated.name).toBe('gpu-box-2');
    expect(updated.port).toBe(2222);
    expect(updated.createdAt).toBe(created.createdAt);

    await repository.remove(created.id);
    await expect(repository.list()).resolves.toEqual([]);
  });

  it('sorts hosts by name', async () => {
    const repository = new JsonHostRepository(createMemoryStringStore(), () => new Date(), () =>
      crypto.randomUUID(),
    );
    await repository.create({ ...input, name: 'zeta' });
    await repository.create({ ...input, name: 'alpha' });
    const names = (await repository.list()).map((host) => host.name);
    expect(names).toEqual(['alpha', 'zeta']);
  });

  it('throws when updating or removing a missing host', async () => {
    const { repository } = createRepository();
    await expect(repository.update('missing', input)).rejects.toBeInstanceOf(HostNotFoundError);
    await expect(repository.remove('missing')).rejects.toBeInstanceOf(HostNotFoundError);
  });

  it('rejects invalid fields', async () => {
    const { repository } = createRepository();
    await expect(repository.create({ ...input, name: '' })).rejects.toThrow();
    await expect(repository.create({ ...input, port: 0 })).rejects.toThrow();
  });

  it('never writes credentials to storage', async () => {
    const { store, repository } = createRepository();
    await repository.create({
      ...input,
      password: 'hunter2',
    } as typeof input & { password: string });

    const raw = await store.getItem(HOSTS_STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(raw).not.toContain('hunter2');
    const parsed = JSON.parse(raw ?? '') as { hosts: Record<string, unknown>[] };
    expect(parsed.hosts[0].password).toBeUndefined();
    expect(parsed.hosts[0]).toMatchObject({
      name: 'gpu-box',
      hostname: 'gpu01.example.com',
      username: 'ubuntu',
      authType: 'password',
    });
  });
});
