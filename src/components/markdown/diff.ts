export type DiffLineKind = 'added' | 'removed' | 'meta' | 'hunk' | 'context';

export type DiffLine = { text: string; kind: DiffLineKind };

const DIFF_LANGUAGES = new Set(['diff', 'patch', 'udiff']);

const META_PREFIXES = [
  'diff --git',
  'index ',
  'new file',
  'deleted file',
  'old mode',
  'new mode',
  'similarity index',
  'rename from',
  'rename to',
  'copy from',
  'copy to',
  'Binary files',
  '\\ No newline',
];

export function isDiffLanguage(language?: string | null): boolean {
  if (!language) {
    return false;
  }
  return DIFF_LANGUAGES.has(language.trim().toLowerCase());
}

function kindFor(line: string): DiffLineKind {
  if (line.startsWith('@@')) {
    return 'hunk';
  }
  // File headers must be classified before the single-character +/- checks.
  if (line.startsWith('+++') || line.startsWith('---')) {
    return 'meta';
  }
  if (META_PREFIXES.some((prefix) => line.startsWith(prefix))) {
    return 'meta';
  }
  if (line.startsWith('+')) {
    return 'added';
  }
  if (line.startsWith('-')) {
    return 'removed';
  }
  return 'context';
}

export function parseDiff(text: string): DiffLine[] {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => ({ text: line, kind: kindFor(line) }));
}
