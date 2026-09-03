export function normalizeRemoteFolderPath(value: string): string {
  const trimmed = value.trim();
  const homeRelative = !trimmed.startsWith('/');
  const raw = trimmed === '~' || trimmed.startsWith('~/')
    ? trimmed.slice(1)
    : homeRelative
      ? `/${trimmed}`
      : trimmed;
  const segments: string[] = [];
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  if (homeRelative) {
    return segments.length > 0 ? `~/${segments.join('/')}` : '~';
  }
  return segments.length > 0 ? `/${segments.join('/')}` : '/';
}

export function remoteFolderSftpPath(path: string): string {
  const normalized = normalizeRemoteFolderPath(path);
  return normalized === '~'
    ? '.'
    : normalized.startsWith('~/')
      ? `./${normalized.slice(2)}`
      : normalized;
}

export function childRemoteFolderPath(parent: string, name: string): string {
  return normalizeRemoteFolderPath(
    parent === '/' ? `/${name}` : `${parent}/${name}`,
  );
}

export function isValidRemoteFolderName(value: string): boolean {
  const name = value.trim();
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('\0')
  );
}

export function parentRemoteFolderPath(path: string): string | null {
  const normalized = normalizeRemoteFolderPath(path);
  if (normalized === '~' || normalized === '/') {
    return null;
  }
  const separator = normalized.lastIndexOf('/');
  if (normalized.startsWith('~/') && separator === 1) {
    return '~';
  }
  if (separator <= 0) {
    return '/';
  }
  return normalized.slice(0, separator);
}
