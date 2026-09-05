# ADR 009: Assistant Markdown rendering

Status: accepted; received snapshots now render without simulated typing.

[Decision index](README.md) | [Current rendering guide](../markdown-rendering.md)

## Context

The original limited parser exposed Markdown markers and lacked table,
code-highlighting, and copy affordances. Agent transcripts can contain
incomplete syntax while an output file is still being written.

The product also needs custom code-block chrome and per-line diff colors.
A renderer exposing only styling callbacks would not satisfy those node-level
requirements.

## Decision

Use `react-native-marked` through `useMarkdown`, a project-owned `Renderer`
subclass, `prism-react-renderer` for code, and `remend` for partial inline
syntax. Render diff lines through a dedicated component. Keep parsing on the
JavaScript thread.

## Consequences

Message blocks use React Native primitives and the existing theme. The plain
container avoids nesting a Markdown `FlatList` inside the transcript list.
Parsing still processes the full string on changed content.

`MarkdownMessage` and its parser configuration are memoized. The renderer
assigns counter-based keys and does not guarantee node identity across changed
parses.

The bridge reads transcript snapshots rather than ephemeral provider token
events. History and newly received text display immediately; no typewriter
effect replays completed output.

LaTeX is not rendered. Images use text placeholders, and only HTTP/HTTPS links
are interactive. The [current guide](../markdown-rendering.md) owns limits,
language support, and extension instructions.

## Rules

- Use `useMarkdown`, not a nested list component.
- Keep parser options stable and give generated elements keys.
- Fall back to plain text when syntax highlighting is unavailable.
- Do not describe snapshot animation as genuine token streaming.
