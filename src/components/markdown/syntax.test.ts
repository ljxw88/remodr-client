import { highlight, languageLabel, resolveLanguage } from '@/components/markdown/syntax';

describe('syntax highlighting', () => {
  describe('resolveLanguage', () => {
    it('maps aliases onto bundled grammars', () => {
      expect(resolveLanguage('ts')).toBe('typescript');
      expect(resolveLanguage('JS')).toBe('javascript');
      expect(resolveLanguage('yml')).toBe('yaml');
      expect(resolveLanguage('rs')).toBe('rust');
    });

    it('registers a shell grammar for agent command output', () => {
      expect(resolveLanguage('bash')).toBe('shell');
      expect(resolveLanguage('sh')).toBe('shell');
      expect(resolveLanguage('zsh')).toBe('shell');
    });

    it('ignores info-string suffixes after the language', () => {
      expect(resolveLanguage('ts title="a.ts"')).toBe('typescript');
    });

    it('returns null for unknown or missing languages', () => {
      expect(resolveLanguage(undefined)).toBeNull();
      expect(resolveLanguage('')).toBeNull();
      expect(resolveLanguage('brainfuck')).toBeNull();
    });
  });

  describe('highlight', () => {
    it('assigns roles to typescript tokens', () => {
      const [line] = highlight('const x = 42;', 'ts');
      const roles = new Map(line.map((token) => [token.text.trim(), token.role]));

      expect(roles.get('const')).toBe('keyword');
      expect(roles.get('42')).toBe('number');
      expect(roles.get('=')).toBe('operator');
    });

    it('highlights shell commands, flags and comments', () => {
      const [line] = highlight('npm install --save-dev jest # setup', 'bash');
      const roles = new Map(line.map((token) => [token.text.trim(), token.role]));

      expect(roles.get('npm')).toBe('function');
      expect(roles.get('--save-dev')).toBe('attribute');
      expect(roles.get('# setup')).toBe('comment');
    });

    it('keeps one entry per source line', () => {
      expect(highlight('a\nb\nc', 'txt')).toHaveLength(3);
      expect(highlight('const a = 1;\nconst b = 2;', 'ts')).toHaveLength(2);
    });

    it('falls back to plain text for unknown languages', () => {
      expect(highlight('some output', 'brainfuck')).toEqual([
        [{ text: 'some output', role: 'plain' }],
      ]);
    });

    it('represents blank lines as empty token rows', () => {
      expect(highlight('a\n\nb', undefined)[1]).toEqual([]);
    });
  });

  describe('languageLabel', () => {
    it('prettifies known languages', () => {
      expect(languageLabel('ts')).toBe('TypeScript');
      expect(languageLabel('json')).toBe('JSON');
      expect(languageLabel('bash')).toBe('Bash');
      expect(languageLabel('sh')).toBe('Shell');
    });

    it('falls back to the raw tag or a generic label', () => {
      expect(languageLabel('nim')).toBe('nim');
      expect(languageLabel(undefined)).toBe('Code');
      expect(languageLabel('  ')).toBe('Code');
    });
  });
});
