import {
  decodeHostRecords,
  encodeHostRecords,
  parseHostForm,
  type HostFormFields,
  type HostProfile,
} from '@/domain/hosts';

const validForm: HostFormFields = {
  name: ' gpu-box ',
  hostname: ' gpu01.example.com ',
  port: '22',
  username: ' ubuntu ',
  authType: 'privateKey',
};

const validHost: HostProfile = {
  id: 'host_1',
  name: 'gpu-box',
  hostname: 'gpu01.example.com',
  port: 22,
  username: 'ubuntu',
  authType: 'password',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('parseHostForm', () => {
  it('accepts trimmed values and default SSH port', () => {
    const result = parseHostForm(validForm);
    expect(result).toEqual({
      ok: true,
      data: {
        name: 'gpu-box',
        hostname: 'gpu01.example.com',
        port: 22,
        username: 'ubuntu',
        authType: 'privateKey',
      },
    });
  });

  it('requires name, hostname, and username', () => {
    const result = parseHostForm({
      name: '  ',
      hostname: '',
      port: '22',
      username: ' ',
      authType: 'password',
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.fieldErrors.name).toBe('Name is required');
    expect(result.fieldErrors.hostname).toBe('Hostname is required');
    expect(result.fieldErrors.username).toBe('Username is required');
  });

  it.each(['', 'abc', '0', '65536', '-1', '22.5'])('rejects port %s', (port) => {
    const result = parseHostForm({ ...validForm, port });
    expect(result.ok).toBe(false);
  });

  it('accepts port 1 and 65535', () => {
    expect(parseHostForm({ ...validForm, port: '1' }).ok).toBe(true);
    expect(parseHostForm({ ...validForm, port: '65535' }).ok).toBe(true);
  });
});

describe('host record persistence', () => {
  it('round-trips host metadata', () => {
    const encoded = encodeHostRecords([validHost]);
    expect(decodeHostRecords(encoded)).toEqual([validHost]);
  });

  it('returns an empty list for missing or corrupt data', () => {
    expect(decodeHostRecords(null)).toEqual([]);
    expect(decodeHostRecords('{not json')).toEqual([]);
    expect(decodeHostRecords(JSON.stringify({ version: 2, hosts: [validHost] }))).toEqual([]);
  });

  it('skips invalid host entries', () => {
    const encoded = JSON.stringify({
      version: 1,
      hosts: [validHost, { id: 'bad' }, { ...validHost, port: 0 }],
    });
    expect(decodeHostRecords(encoded)).toEqual([validHost]);
  });

  it('does not persist secret fields', () => {
    const encoded = encodeHostRecords([
      {
        ...validHost,
        password: 'hunter2',
        privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
        passphrase: 'secret',
      } as HostProfile,
    ]);

    expect(encoded).not.toContain('hunter2');
    expect(encoded).not.toContain('BEGIN OPENSSH');
    expect(encoded).not.toContain('secret');

    const parsed = JSON.parse(encoded) as { hosts: Record<string, unknown>[] };
    const keys = Object.keys(parsed.hosts[0]);
    expect(keys.sort()).toEqual(
      ['authType', 'createdAt', 'hostname', 'id', 'name', 'port', 'updatedAt', 'username'].sort(),
    );
  });
});
