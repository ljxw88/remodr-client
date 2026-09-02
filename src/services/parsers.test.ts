import { parseDiskUsage, parseFreeMemory, parseNvidiaSmi, parseUptime } from '@/services/parsers';

describe('parsers', () => {
  it('parses uptime', () => {
    expect(parseUptime(' 12:00:00 up 3 days\n')).toBe('12:00:00 up 3 days');
  });

  it('parses free -b', () => {
    const parsed = parseFreeMemory('Mem:  16000000000 8000000000 2000000000');
    expect(parsed).toEqual({ totalBytes: 16000000000, usedBytes: 8000000000, freeBytes: 2000000000 });
  });

  it('parses df -P', () => {
    const parsed = parseDiskUsage('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 40 60 40% /');
    expect(parsed[0]).toMatchObject({ filesystem: '/dev/sda1', mount: '/', capacity: '40%' });
  });

  it('parses nvidia-smi csv', () => {
    const parsed = parseNvidiaSmi('NVIDIA A100, 12 %, 1024, 40960, 41, 70.00');
    expect(parsed[0].name).toBe('NVIDIA A100');
    expect(parsed[0].memoryTotal).toBe('40960');
  });
});
