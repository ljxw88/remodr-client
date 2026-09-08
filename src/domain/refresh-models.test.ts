import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import copilot from './__fixtures__/copilot.json';

const { parseArgs, refresh, writeCatalogue } = require('../../scripts/refresh-models.cjs');

describe('model refresh publication', () => {
  let directory: string;
  beforeEach(async () => {
    directory = path.join(process.cwd(), `.remodr-models-test-${randomUUID()}`);
    await mkdir(directory);
    await writeFile(path.join(directory, 'copilot.json'), JSON.stringify(copilot));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('selects all vendors by default and validates arguments', () => {
    expect(parseArgs([]).providers).toEqual(['copilot']);
    expect(parseArgs(['--provider', 'copilot', '--provider', 'copilot']).providers).toEqual(['copilot']);
    for (const provider of ['opencode', 'claude', 'codex', 'cursor']) {
      expect(() => parseArgs(['--provider', provider])).toThrow();
    }
    expect(() => parseArgs(['--unknown'])).toThrow();
    expect(() => parseArgs(['--provider'])).toThrow();
    expect(() => parseArgs(['--check', '--dry-run'])).toThrow();
  });

  it('publishes validated data to the matching vendor file', async () => {
    const next = { ...copilot, updatedAt: '2026-09-05T12:00:00.000Z' };
    await refresh(parseArgs(['--provider', 'copilot']), {
      directory, fetchProvider: async () => next, log: jest.fn(),
    });
    expect(JSON.parse(await readFile(path.join(directory, 'copilot.json'), 'utf8'))).toEqual(next);
  });

  it('leaves the snapshot untouched when discovery fails', async () => {
    const before = await readFile(path.join(directory, 'copilot.json'), 'utf8');
    await expect(refresh(parseArgs(['--provider', 'copilot']), {
      directory, log: jest.fn(),
      fetchProvider: async () => { throw new Error('Copilot is not installed'); },
    })).rejects.toThrow('Copilot is not installed');
    expect(await readFile(path.join(directory, 'copilot.json'), 'utf8')).toBe(before);
  });

  it('rejects empty/mismatched results without overwriting a catalog', async () => {
    const before = await readFile(path.join(directory, 'copilot.json'), 'utf8');
    await expect(writeCatalogue({ ...copilot, models: [] }, directory)).rejects.toThrow();
    await expect(refresh(parseArgs(['--provider', 'copilot']), {
      directory, log: jest.fn(), fetchProvider: async () => ({
        ...copilot, provider: 'unsupported',
      }),
    })).rejects.toThrow();
    expect(await readFile(path.join(directory, 'copilot.json'), 'utf8')).toBe(before);
  });

  it('dry run fetches without writing; check validates without fetching', async () => {
    const fetchProvider = jest.fn(async () => copilot);
    const before = await readFile(path.join(directory, 'copilot.json'), 'utf8');
    await refresh(parseArgs(['--provider', 'copilot', '--dry-run']), {
      directory, fetchProvider, log: jest.fn(),
    });
    expect(fetchProvider).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(directory, 'copilot.json'), 'utf8')).toBe(before);
    fetchProvider.mockClear();
    await refresh(parseArgs(['--provider', 'copilot', '--check']), {
      directory, fetchProvider, log: jest.fn(),
    });
    expect(fetchProvider).not.toHaveBeenCalled();
  });
});
