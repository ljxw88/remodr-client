import { normalizeTokens, Prism } from 'prism-react-renderer';

export type SyntaxRole =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'function'
  | 'type'
  | 'operator'
  | 'tag'
  | 'attribute';

export type SyntaxToken = { text: string; role: SyntaxRole };

const MAX_HIGHLIGHT_LENGTH = 20_000;

const ALIASES: Record<string, string> = {
  bash: 'shell',
  console: 'shell',
  golang: 'go',
  htm: 'html',
  js: 'javascript',
  jsonc: 'json',
  mjs: 'javascript',
  node: 'javascript',
  objectivec: 'objc',
  postgres: 'sql',
  postgresql: 'sql',
  rs: 'rust',
  sh: 'shell',
  shellsession: 'shell',
  ts: 'typescript',
  yml: 'yaml',
  zsh: 'shell',
};

const ROLES: Record<string, SyntaxRole> = {
  'attr-name': 'attribute',
  'attr-value': 'string',
  'class-name': 'type',
  'function-variable': 'function',
  'maybe-class-name': 'type',
  atrule: 'keyword',
  boolean: 'number',
  builtin: 'type',
  cdata: 'comment',
  char: 'string',
  comment: 'comment',
  constant: 'number',
  doctype: 'comment',
  entity: 'operator',
  function: 'function',
  important: 'keyword',
  keyword: 'keyword',
  namespace: 'type',
  number: 'number',
  operator: 'operator',
  parameter: 'attribute',
  prolog: 'comment',
  property: 'attribute',
  punctuation: 'operator',
  regex: 'string',
  rule: 'keyword',
  selector: 'tag',
  string: 'string',
  symbol: 'number',
  tag: 'tag',
  unit: 'number',
  url: 'operator',
  variable: 'attribute',
};

const SHELL_COMMANDS =
  'apt|awk|brew|cargo|cat|cd|chmod|cp|curl|docker|echo|expo|find|git|go|grep|head|kill|ls|make|mkdir|mv|node|npm|npx|pip|pnpm|python3?|rm|scp|sed|source|ssh|sudo|tail|tar|tsc|wget|yarn';

function registerShell() {
  if (Prism.languages.shell) {
    return;
  }
  Prism.languages.shell = {
    comment: { pattern: /(^|[^"'\\$])#.*/, lookbehind: true, greedy: true },
    string: [
      { pattern: /"(?:\\[\s\S]|[^"\\])*"/, greedy: true },
      { pattern: /'(?:\\[\s\S]|[^'\\])*'/, greedy: true },
    ],
    variable: /\$(?:\{[^}]*\}|[\w@?#*!-]+)/,
    function: {
      pattern: new RegExp(`(^|[\\s;|&(])(?:${SHELL_COMMANDS})(?=$|[\\s;|&)])`),
      lookbehind: true,
    },
    keyword:
      /\b(?:case|do|done|elif|else|esac|export|fi|for|function|if|in|local|return|then|until|while)\b/,
    'attr-name': /(?:^|\s)--?[\w-]+/,
    operator: /&&|\|\||[|&<>;=]/,
    number: /\b\d+(?:\.\d+)?\b/,
    punctuation: /[{}()[\],]/,
  };
}

registerShell();

/**
 * Resolves a fence language to a grammar Prism actually bundles. Returns null
 * when the language is unknown so callers can fall back to unstyled text.
 */
export function resolveLanguage(language?: string | null): string | null {
  if (!language) {
    return null;
  }
  const normalized = language.trim().toLowerCase().split(/[\s:,]/)[0];
  if (!normalized) {
    return null;
  }
  const resolved = ALIASES[normalized] ?? normalized;
  return Prism.languages[resolved] ? resolved : null;
}

const LABELS: Record<string, string> = {
  bash: 'Bash',
  c: 'C',
  console: 'Console',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  diff: 'Diff',
  dockerfile: 'Dockerfile',
  go: 'Go',
  graphql: 'GraphQL',
  html: 'HTML',
  ini: 'INI',
  java: 'Java',
  javascript: 'JavaScript',
  js: 'JavaScript',
  json: 'JSON',
  jsonc: 'JSON',
  jsx: 'JSX',
  kotlin: 'Kotlin',
  markdown: 'Markdown',
  md: 'Markdown',
  objc: 'Objective-C',
  patch: 'Diff',
  plaintext: 'Text',
  python: 'Python',
  rs: 'Rust',
  rust: 'Rust',
  sh: 'Shell',
  shell: 'Shell',
  sql: 'SQL',
  swift: 'Swift',
  text: 'Text',
  toml: 'TOML',
  ts: 'TypeScript',
  tsx: 'TSX',
  txt: 'Text',
  typescript: 'TypeScript',
  xml: 'XML',
  yaml: 'YAML',
  yml: 'YAML',
  zsh: 'Zsh',
};

export function languageLabel(language?: string | null): string {
  const normalized = language?.trim();
  if (!normalized) {
    return 'Code';
  }
  return LABELS[normalized.toLowerCase()] ?? normalized;
}

function roleFor(types: string[]): SyntaxRole {
  for (const type of types) {
    const role = ROLES[type];
    if (role) {
      return role;
    }
  }
  return 'plain';
}

function plainLines(code: string): SyntaxToken[][] {
  return code.split('\n').map((line) => (line ? [{ text: line, role: 'plain' as const }] : []));
}

/**
 * Splits code into highlighted lines. Unknown languages and oversized blocks
 * degrade to plain text rather than blocking the render.
 */
export function highlight(code: string, language?: string | null): SyntaxToken[][] {
  const resolved = resolveLanguage(language);
  if (!resolved || code.length > MAX_HIGHLIGHT_LENGTH) {
    return plainLines(code);
  }
  try {
    const lines = normalizeTokens(Prism.tokenize(code, Prism.languages[resolved]));
    return lines.map((line) =>
      line
        .filter((token) => token.content !== '')
        .map((token) => ({ text: token.content, role: roleFor(token.types) })),
    );
  } catch {
    return plainLines(code);
  }
}
