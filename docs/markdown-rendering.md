# Assistant Markdown rendering

[Documentation index](README.md) | [Decision](adr/009-assistant-markdown-rendering.md)

`MarkdownMessage` renders the latest `assistant_message.markdown` value as
native React Native views:

```text
received Markdown string
    -> clamp to 100,000 characters
    -> remend partial-syntax repair
    -> react-native-marked useMarkdown
    -> ChatMarkdownRenderer
    -> View containing native message blocks
```

## Source map

| File | Responsibility |
| --- | --- |
| [`markdown-message.tsx`](../src/components/markdown/markdown-message.tsx) | Memoized public component, length cap, repair and parser setup |
| [`renderer.tsx`](../src/components/markdown/renderer.tsx) | Custom code/table/link/image rendering and generated node keys |
| [`code-block.tsx`](../src/components/markdown/code-block.tsx) | Language label, copy action, scrolling, and diff rendering |
| [`syntax.ts`](../src/components/markdown/syntax.ts) | Prism grammars, aliases, shell registration, highlighting limit |
| [`diff.ts`](../src/components/markdown/diff.ts) | Added/removed/hunk/meta/context line classification |
| [`markdown-theme.ts`](../src/components/markdown/markdown-theme.ts) | Message typography, block spacing, syntax and diff colors |
| [`conversation-refresh.ts`](../src/features/agents/conversation-refresh.ts) | Visible-chat polling cadence and shared in-flight gate |
| [`use-conversation-controller.ts`](../src/features/agents/use-conversation-controller.ts) | Restore, refresh lifecycle, retry/error state and completion receipts |
| [`conversation-message-list.tsx`](../src/features/agents/conversation-message-list.tsx) | Inverted transcript list, message/tool/plan rows and empty states |
| [`conversation-composer.tsx`](../src/features/agents/conversation-composer.tsx) | Input, send/model controls, question-bar slot and measured overlay layout |

The chat calls `MarkdownMessage` directly for assistant rows. There is no
client-side typewriter timer or prefix slicing.

## Snapshots and live output

The bridge reads provider transcript files. It does not subscribe to Copilot's
ephemeral `assistant.message_delta` token events. Some providers/log formats
make completed messages available only at the end; the app displays those
whole instead of simulating their generation.

The focused, foreground, connected chat refreshes every 1-2 seconds while
working or discovering an unanswered question. It refreshes every 3 seconds
when idle/done, including while a question is already visible. This catches
final file writes that follow a done-status event. Reads are serialized across
effect restarts and stop when the chat loses focus, backgrounds, or disconnects.

`ConversationStore` skips unchanged transcript writes/publications. Component
memoization avoids reparsing unchanged Markdown. Changed text is still parsed
as a full string on the JavaScript thread; this is not incremental parsing.

True token streaming would need a provider event transport. The
[Copilot SDK streaming guide](https://github.com/github/copilot-sdk/blob/main/docs/features/streaming-events.md)
describes that separate API.

## Rendering behavior

`useMarkdown` returns blocks for a plain `View`. Do not replace it with the
library's `Markdown` component inside the chat: that component creates another
`FlatList` inside the transcript list.

The renderer instance and parser options are memoized. `getKey()` assigns
counter-based keys, including a key for the table wrapper. Node identity is not
guaranteed across changed parses. Unchanged-message memoization and explicit keys
should not be confused with incremental reconciliation.

Tables size columns from available width, with a 112dp minimum, and scroll
horizontally when necessary. Code blocks also scroll horizontally and offer a
copy action.

Only HTTP/HTTPS links are interactive. Other URI schemes render as text.
Images render an `[Image: ...]` placeholder using alt/title text; transcript
images do not mount network image components.

`remend` repairs partial inline syntax:

| Input during an update | Display |
| --- | --- |
| `This is **bold` | Bold text without exposed delimiter markers |
| `` Run `npm inst `` | Inline code while the closing delimiter is missing |
| An unclosed fenced block | Code through the end of the current message |

Unclosed fences already have defined Markdown behavior; repair does not need
to invent a closing fence. Math repair is disabled because there is no math
renderer and `$` is common in shell output.

## Extending the renderer

- Add language aliases and labels in `syntax.ts`. Check `resolveLanguage()`
  against the installed Prism bundle instead of assuming a grammar exists.
  Shell is registered by the project; diff rendering has a separate path.
- Blocks longer than `MAX_HIGHLIGHT_LENGTH` (20,000 characters), unknown
  grammars, or highlighting failures render without syntax tokenization.
- Change transcript text size through `MessageText` in `markdown-theme.ts`.
  User bubbles use the same base typography.
- Change block rhythm through `blockStyles.container.gap` and the existing
  heading styles rather than independent margins in every renderer method.
- Match the installed `Renderer` interface when overriding a node and assign
  a key to generated elements.

## Deliberate limits

LaTeX is not rendered. `$E = mc^2$` and `$$...$$` remain text; ordinary Markdown
escaping can remove the backslashes from `\(x^2\)`. Supporting mathematical
layout would require a tokenizer/renderer design, not just enabling a repair
option.

Diff fences color lines by change type. They do not tokenize code within each
diff line. Message content beyond the 100,000-character rendering cap is not
displayed by `MarkdownMessage`.

## Checks

```bash
npm test -- --runInBand src/components/markdown \
  src/features/agents/conversation-refresh.test.ts \
  src/features/agents/use-conversation-controller.test.ts \
  src/features/agents/conversation-display.test.ts \
  src/services/herdr-repository.test.ts
```

Tests cover Markdown output, incomplete syntax, image/link policy, long saved
replies, unchanged-message parsing, stale activity, serialized refreshes and
late final output. The test filename pattern is `src/**/*.test.ts`, so renderer
tests use `createElement` rather than JSX. Read `toJSON()` after `act()` returns.

Jest's ESM transforms, `remend` mapping, and CSS stub are configured in
[`package.json`](../package.json). Do not copy that test configuration into Metro
without a separate runtime need.
