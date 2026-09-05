# ADR 014: Questions above the composer

Status: accepted; queued delivery follows [ADR 015](015-connection-recovery.md).

[Decision index](README.md) | [Bridge integration](../herdr-mobile-architecture.md)

## Context

An agent can pause for a choice. Keeping the only answer controls inside a
scrolling transcript makes them easy to lose while reading other output.

The Copilot adapter normalizes `ask_user` into `activeHumanRequest`. Herdr's
pane-level `blocked` status is separate: it does not prove that a structured
question exists.

## Decision

Pin answer controls in `HumanRequestBar` above the composer. Keep the transcript
read-only, rendering the question there once it is resolved.

Single-select choices submit on tap. Multi-select choices have an explicit
send step. Text-only questions use the composer rather than an empty button bar.

## Current normalization and delivery

The bridge accepts both plain `{question, choices}` requests and
`{message, requestedSchema}` requests. For the latter it normalizes the first
schema property; this is not a general multi-field form renderer. Long question
text can expand on tap in the bar.

Copilot's selection dialog blocks `agent.prompt`, so the bridge answers through
`agent.send_keys`. It anchors against a clamped end of the list before selecting
an option or the freeform row, rather than assuming the initial cursor
position. Keystroke batches leave time for the dialog to redraw.

For confirmation questions, `answerBodyFor` maps app-supplied Yes/No controls to
custom text rather than pretending they are provider option IDs. Normalization
and input conversion live in the bridge and
[`human-request.ts`](../../src/features/agents/human-request.ts).

The current Claude/Codex adapters do not produce structured questions, and
OpenCode uses raw fallback output. Do not infer controls from unstructured
terminal text.

## Durable queue behavior

An enqueue acknowledgement means the answer was saved locally, not delivered.
The bar distinguishes queued, sending, acknowledged, failed, and uncertain
states. It keeps a pending answer locked until its state is resolved or the user
explicitly discards it. An acknowledged answer stays latched until the question
disappears.

The composer and bar share a synchronous submission guard. The outbox also
deduplicates answers by agent/question ID before writing. Server-side
preconditions bind delivery to the current provider session, pane, and question.
Uncertain side effects are not automatically replayed.

## Rules

- Keep the bar keyed by request ID so a new question does not inherit selection.
- Do not put a second set of answer controls in transcript rows.
- Keep composer height measured so the question bar and draft do not cover the
  newest message.
- Do not equate `blocked` with a structured question or queued with delivered.
- Refresh while discovering a question, and retain the current slower
  foreground idle refresh afterward. The old rule to stop polling once the
  question arrived is superseded by
  [`conversation-refresh.ts`](../../src/features/agents/conversation-refresh.ts).
