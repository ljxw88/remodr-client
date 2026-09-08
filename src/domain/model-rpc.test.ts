import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';

jest.mock('node:child_process', () => ({ spawn: jest.fn() }));
const { openRpc } = require('../../scripts/model-rpc.cjs');

function processStub() {
  const child = new EventEmitter();
  const writes: string[] = [];
  return Object.assign(child, {
    stdin: new Writable({ write(chunk, _encoding, done) { writes.push(chunk.toString()); done(); } }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: jest.fn(),
    writes,
  });
}

describe('model discovery RPC transport', () => {
  it('handles fragmented byte-counted Copilot frames and ignores notifications', async () => {
    const child = processStub();
    jest.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const rpc = openRpc('copilot', ['--headless']);
    try {
      const result = rpc.request('models.list');
      const json = JSON.stringify({ id: 1, result: { name: 'Modèle' } });
      const frame = Buffer.from(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
      child.stdout.write(frame.subarray(0, 17));
      child.stdout.write(frame.subarray(17, frame.length - 2));
      child.stdout.write(frame.subarray(frame.length - 2));
      await expect(result).resolves.toEqual({ name: 'Modèle' });
      expect(child.writes[0]).toContain('Content-Length:');
    } finally {
      rpc.close();
    }
    expect(child.kill).toHaveBeenCalled();
  });

  it('surfaces RPC failures', async () => {
    const child = processStub();
    jest.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const rpc = openRpc('copilot', ['--headless']);
    try {
      const result = rpc.request('models.list');
      const body = JSON.stringify({ id: 1, error: { code: -32000 } });
      child.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      await expect(result).rejects.toThrow('RPC error -32000');
    } finally {
      rpc.close();
    }
  });

  it('surfaces missing binaries and malformed responses instead of hanging', async () => {
    for (const malformed of [false, true]) {
      const child = processStub();
      jest.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
      const rpc = openRpc('copilot', []);
      const result = rpc.request('model/list');
      if (malformed) child.stdout.write('Content-Length: 8\r\n\r\nnot json');
      else child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
      await expect(result).rejects.toThrow(malformed ? 'malformed discovery' : 'ENOENT');
      rpc.close();
    }
  });

  it('bounds discovery waits and stops the specific child', async () => {
    jest.useFakeTimers();
    const child = processStub();
    jest.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const rpc = openRpc('copilot', ['--headless'], 10);
    try {
      const result = rpc.request('model/list');
      const rejection = expect(result).rejects.toThrow('timed out');
      jest.advanceTimersByTime(10);
      await rejection;
      expect(child.kill).toHaveBeenCalled();
    } finally {
      rpc.close();
      jest.useRealTimers();
    }
  });
});
