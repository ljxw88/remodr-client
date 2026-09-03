import { isDiffLanguage, parseDiff } from '@/components/markdown/diff';

describe('diff parsing', () => {
  it('recognises diff fence languages', () => {
    expect(isDiffLanguage('diff')).toBe(true);
    expect(isDiffLanguage('Patch')).toBe(true);
    expect(isDiffLanguage('ts')).toBe(false);
    expect(isDiffLanguage(undefined)).toBe(false);
  });

  it('classifies added, removed and context lines', () => {
    const lines = parseDiff(['+added', '-removed', ' context'].join('\n'));

    expect(lines.map((line) => line.kind)).toEqual(['added', 'removed', 'context']);
  });

  it('treats file headers as metadata rather than additions', () => {
    const lines = parseDiff(['--- a/src/app.ts', '+++ b/src/app.ts'].join('\n'));

    expect(lines.map((line) => line.kind)).toEqual(['meta', 'meta']);
  });

  it('marks hunk headers separately', () => {
    expect(parseDiff('@@ -1,4 +1,6 @@')[0].kind).toBe('hunk');
  });

  it('marks git metadata lines', () => {
    const lines = parseDiff(
      ['diff --git a/a.ts b/a.ts', 'index 1234567..89abcde 100644', 'new file mode 100644'].join(
        '\n',
      ),
    );

    expect(lines.every((line) => line.kind === 'meta')).toBe(true);
  });

  it('preserves line text and handles CRLF input', () => {
    const lines = parseDiff('+one\r\n-two');

    expect(lines.map((line) => line.text)).toEqual(['+one', '-two']);
  });
});
