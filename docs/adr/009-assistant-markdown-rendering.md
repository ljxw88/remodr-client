# ADR 009: Assistant markdown rendering

## Context

Agent replies arrive as markdown and were rendered by a hand-written parser
that supported only fenced code, inline code, links, headings, and flat
bullets. Bold, italic, tables, blockquotes, nested lists, and heading levels
leaked raw markers into the transcript. Code blocks had no language, no
highlighting, and no copy action.

Content streams in chunk by chunk, so a message is re-rendered many times and
is frequently observed mid-token with an unterminated fence or emphasis run.

`react-native-markdown-display`, the long-standing default, carries a "no
longer actively maintained" notice and points at
`react-native-enriched-markdown`, a native Fabric renderer. That renderer has
the better streaming story but exposes styling and callbacks only, with no
custom node renderers, which rules out per-line `diff` colouring.

## Decision

Parse with `react-native-marked` through its `useMarkdown` hook and render into
React Native primitives with a project-owned `Renderer` subclass. Highlight
code with `prism-react-renderer`. Repair partial markdown with `remend`.
Render `diff` fences with a dedicated component rather than a grammar.

Keep the parser on the JS thread. Do not adopt a native markdown renderer.

## Reasons

- Custom node renderers are required for diff colouring and code-block chrome.
- Everything maps to `<Text>`/`<View>`, so the existing theme tokens apply
  directly and no second styling system enters the codebase.
- `remend` is a zero-dependency string-to-string repair step, so it stays
  useful even if the renderer is replaced later.
- Prism tokenises without a DOM and compiles under Hermes. Shiki cannot: its
  JavaScript engine emits ES2024 `v`-flag regexes that Hermes rejects.

## Consequences

Parsing and highlighting run on the JS thread and re-run on every streaming
update. Long messages re-parse in full per chunk.

`react-native-marked` requires `react-native-svg`, and the copy action requires
`expo-clipboard`, so both are native additions that need an app rebuild.

Jest needs `transformIgnorePatterns` and `moduleNameMapper` entries for the ESM
dependencies. Metro needs neither.

LaTeX is not rendered.

## Rules

- Render through the `useMarkdown` hook, never the `Markdown` component; the
  component nests a `FlatList` inside the transcript's `FlatList`.
- Keep `markdownStyles` and the renderer instance referentially stable. The
  hook memoises the parse on those identities.
- Give every node a key, and rewind `resetKeys` before each parse.
- Degrade unknown languages and oversized blocks to plain text. Never let a
  highlighting failure block a message.
