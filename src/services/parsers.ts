export type MemoryStats = {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
};

export type DiskStats = {
  filesystem: string;
  size: string;
  used: string;
  available: string;
  capacity: string;
  mount: string;
};

export type ProcessRow = {
  user: string;
  pid: string;
  cpu: string;
  mem: string;
  command: string;
};

export type GpuStats = {
  name: string;
  utilization: string;
  memoryUsed: string;
  memoryTotal: string;
  temperature: string;
  power: string;
};

export type DockerContainer = {
  id: string;
  image: string;
  status: string;
  names: string;
};

export function parseUptime(output: string): string {
  return output.trim();
}

export function parseFreeMemory(output: string): MemoryStats | null {
  const line = output.split('\n').find((row) => row.startsWith('Mem:'));
  if (!line) {
    return null;
  }
  const parts = line.trim().split(/\s+/);
  const totalBytes = Number(parts[1]);
  const usedBytes = Number(parts[2]);
  const freeBytes = Number(parts[3]);
  if ([totalBytes, usedBytes, freeBytes].some(Number.isNaN)) {
    return null;
  }
  return { totalBytes, usedBytes, freeBytes };
}

export function parseDiskUsage(output: string): DiskStats[] {
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      return {
        filesystem: parts[0] ?? '',
        size: parts[1] ?? '',
        used: parts[2] ?? '',
        available: parts[3] ?? '',
        capacity: parts[4] ?? '',
        mount: parts.slice(5).join(' '),
      };
    });
}

export function parseProcesses(output: string): ProcessRow[] {
  return output
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      return {
        user: parts[0] ?? '',
        pid: parts[1] ?? '',
        cpu: parts[2] ?? '',
        mem: parts[3] ?? '',
        command: parts.slice(10).join(' ') || parts.slice(4).join(' '),
      };
    });
}

export function parseNvidiaSmi(output: string): GpuStats[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, utilization, memoryUsed, memoryTotal, temperature, power] = line.split(',').map((part) => part.trim());
      return { name, utilization, memoryUsed, memoryTotal, temperature, power };
    });
}

export function parseDockerPs(output: string): DockerContainer[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, image, status, names] = line.split('\t');
      return { id: id ?? '', image: image ?? '', status: status ?? '', names: names ?? '' };
    });
}
