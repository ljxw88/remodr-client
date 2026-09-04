# Assistant markdown rendering

How `assistant_message` content is turned into native views. See
[ADR 009](adr/009-assistant-markdown-rendering.md) for why this shape was
chosen.

## Pipeline

```text
item.markdown (string, grows during streaming)
    ↓ clamp to 100k chars
    ↓ remend()                    repair unterminated emphasis / inline code
    ↓ useMarkdown(value, {...})   marked lexer → Parser → ReactNode[]
    ↓ ChatMarkdownRenderer        per-node overrides
<View style={gap: 16}>            plain container, no list
```

Entry point is `MarkdownMessage`, used once in
`src/app/agents/[id].tsx` for `kind === 'assistant_message'`.

## Files

| File | Responsibility |
|---|---|
| `markdown-message.tsx` | Public component. Clamping, `remend`, hook wiring |
| `renderer.tsx` | `Renderer` subclass: `code`, `table`, key management |
| `code-block.tsx` | Fence chrome: language label, copy, scroll, diff branch |
| `syntax.ts` | Language aliases, shell grammar, Prism tokenisation |
| `diff.ts` | Classifies diff lines into added/removed/hunk/meta/context |
| `markdown-theme.ts` | `MarkedStyles`, syntax palette, diff palette, layout |

Dependencies: `react-native-marked` (parser + base renderer),
`prism-react-renderer` (tokeniser), `remend` (stream repair),
`expo-clipboard` (copy), `react-native-svg` (peer of `react-native-marked`).

## Upstream behaviour worked around

These are deliberate overrides, not preference. Removing them reintroduces real
bugs.

**Node keys.** The stock `Renderer` keys nodes with a `github-slugger` instance
that is never reset, so identical markdown yields different keys on every
parse. During streaming that remounts the whole message each chunk.
`ChatMarkdownRenderer.getKey` uses a counter and `resetKeys()` rewinds it
immediately before each parse, so an unchanged prefix keeps its keys.

**Table width.** `getTableWidthArr` assigns *every* column
`windowWidth * 1.3 / 3` regardless of column count, so any table with three or
more columns overflows and is clipped with no way to scroll. `table()` sizes
columns to the available width (floor `MIN_TABLE_COLUMN`, 112dp) and wraps the
result in a horizontal `ScrollView`.

**Table key.** `table()` is the only base renderer method that emits no key.
It is cloned with one. `markdown-message.test.ts` fails if a key warning
returns.

**`FlatList` nesting.** The default `Markdown` component renders its blocks
into a `FlatList`. The transcript in `agents/[id].tsx` is already a `FlatList`,
so that would nest virtualised lists. The `useMarkdown` hook returns
`ReactNode[]` instead, which is why the container is a plain `View`.

**Light-mode defaults.** `getStyles` flattens user styles last, so anything not
overridden in `markdownStyles` keeps a light default. Headings ship a bottom
border, links and inline code ship `fontStyle: italic`. All are explicitly
reset.

## Streaming

`remend` repairs inline syntax so partial tokens never show raw markers:

| Mid-stream input | Rendered |
|---|---|
| `This is **bold` | **bold** |
| `` Run `npm inst `` | `npm inst` |

Unterminated fences need no repair: CommonMark specifies that an unclosed fence
runs to end of document, so `marked` already emits a complete `code` token.
`remend` deliberately leaves fences and partial tables alone.

`katex` and `inlineKatex` are disabled — there is no math renderer, and `$` is
common in shell output.

Cost: the full string is re-lexed on every chunk, on the JS thread. Acceptable
for typical replies; if long transcripts start to jank, throttle updates at the
call site rather than parsing incrementally.

## Extending

**Add a language.** Prism bundles 53 grammars. Check
`resolveLanguage('name')`; if it returns `null` the block renders as plain
text. Map spellings in `ALIASES`, add a display name to `LABELS`. `bash`,
`java`, and `diff` are *not* bundled — `shell` is registered manually in
`registerShell()`, and `diff` is handled by `diff.ts`.

**Change how large a message reads.** `MessageText` in `markdown-theme.ts` is
the one place. Everything else in a message is sized against it, headings
included, and the user's own bubble uses it directly so both sides of a
conversation match. It sits a step below the app's body size: a transcript is
long-form, so fitting more of a sentence on a line is worth more here than
matching the chrome around it.

**Change syntax colours.** `SyntaxColors` in `markdown-theme.ts` maps ten
roles. Prism token types map to roles through `ROLES`; unmapped types fall back
to `plain`.

**Override a node.** Add a method to `ChatMarkdownRenderer` matching
`RendererInterface`. Always assign `key={this.getKey()}`. Call `super` and
`cloneElement` when you only need to adjust the stock output.

**Change block rhythm.** Spacing comes from `blockStyles.container.gap`, not
per-block margins. Headings add `marginTop` on top of it.

## Not supported

**LaTeX.** Verified behaviour, not a crash:

| Input | Rendered |
|---|---|
| `$E = mc^2$` | `$E = mc^2$` verbatim |
| `$$\frac{a}{b}$$` | verbatim, as a paragraph |
| `\(x^2\)` | `(x^2)` — markdown strips the backslashes |

Adding it means a tokenizer extension for `$`/`$$` plus a renderer that draws
fractions, radicals, and scripts from React Native primitives. No maintained
pure-JS React Native math renderer currently exists;
`react-native-enriched-markdown` supports it natively via RaTeX. Agent replies
about code rarely contain math, so this is a deliberate gap.

**Images.** `marked` parses them and the base renderer handles them, but remote
image loading in transcripts has not been reviewed.

**Per-line syntax highlighting inside diffs.** Diff lines are coloured by
change type only; the code within a line is not tokenised.

## Testing

```bash
npx jest src/components/markdown --runInBand
```

`syntax.test.ts` and `diff.test.ts` cover pure logic.
`markdown-message.test.ts` renders through `react-test-renderer` and asserts on
the resulting text, including streaming repair, unterminated fences, and the
absence of key warnings.

Tests are `.ts`, not `.tsx`, because `testMatch` is `src/**/*.test.ts`; they use
`createElement` rather than JSX. Call `toJSON()` *after* `act()` returns, not
inside the callback, or the tree reads back empty.

Jest needs configuration that Metro does not: `marked`, `github-slugger`,
`html-entities`, `@jsamr/*`, and `svg-parser` ship ESM and are added to
`transformIgnorePatterns`; `remend` is ESM-only with no `require` condition and
is mapped directly to its `dist`; `global.css` is stubbed via `jest/`.
