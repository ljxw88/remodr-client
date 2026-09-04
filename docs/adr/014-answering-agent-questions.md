# ADR 014: Where an agent's question gets answered

## Context

An agent can stop and ask the user to choose between options. Herdr already
parses this: the bridge watches the Copilot session log for an `ask_user` tool
call and normalises the first field of its `requestedSchema` into a request
with `id`, `kind`, `question`, `options`, `allowCustomAnswer` and `multiSelect`.
The unanswered one is served as `activeHumanRequest`.

The app rendered those options as a card inline in the transcript. That card is
the only control, so it scrolls. An unanswered question is the one thing
holding the agent up, and it could be anywhere above the fold — or, once the
reply that followed it grew, well off screen.

Codex CLI, Claude Code and Copilot CLI have all met this problem and have
converged on the same shape.

## Decision

Pin the options in a bar directly above the composer while the question is
open. Leave the transcript a read-only record of questions already answered.

## Rationale

- All three reference implementations pin the options next to the input rather
  than in the scrolling transcript. Codex's bottom pane holds "a stack of
  transient views that temporarily replace the composer"; Claude Code's VS Code
  extension puts a permissions container inside the absolutely-positioned input
  container; VS Code chat has a dedicated question-carousel slot above the
  input.
- All three then move the exchange into the transcript once it is answered —
  VS Code branches on `isComplete` to render a `Q:`/`A:` summary, Codex emits a
  `Questions 1/2 answered` cell. So the record is kept, but only after the fact.
  This is why the transcript row renders on `resolved` and not before: pinned
  and inline at once puts the same question on screen twice, and the copy that
  scrolls away is the one without buttons.
- Multi-select gets an explicit send step and single-select commits on tap,
  which is what all three do — Claude's multi-select carries a `Submit` button
  where its single-select commits immediately.
- Typing an answer instead of tapping one stays available throughout. Every
  reference treats this as the designed-for path rather than an escape hatch:
  Codex force-enables a free-form "Other" on every question regardless of what
  the model asked for, Claude synthesises one and tells itself to obey the text
  over the form. Our composer is already that box, and the bridge already
  accepts `customText`, so the bar does not need to reproduce it.

## Consequences

Copilot writes `ask_user` in two shapes depending on the model behind it: a
plain `{question, choices}` pair, and a JSON-Schema `{message,
requestedSchema}`. Both occur in real session logs and the plain one is the
more common by a wide margin, so reading only the schema left most questions
invisible — the agent sat blocked with nothing on screen to answer it.

Answering is not a prompt. A question puts Copilot's own selection dialog on
the pane, and Herdr refuses `agent.prompt` while that is up, returning
`agent_blocked` before sending anything. So the answer is delivered as
keystrokes, the way a person would.

The dialog is the offered answers followed by a synthesised "Other (type your
answer)" row, and the cursor opens on the schema's `default` rather than the
top — stepping down blindly picks the wrong answer. Both ends of the list
clamp, so travelling further than the list is long is what makes a position
certain without reading the screen back: over-travel up to anchor on the first
row and step down to the wanted one, or over-travel down to land on the
freeform row.

Reaching the freeform row swaps the list for a text field, and characters sent
before it has drawn are dropped, so the batches are spaced. Herdr's own prompt
does the same, sending Enter after a short delay.

A confirmation arrives with no options — the bridge only marks a boolean field
as one — so `Yes` and `No` are supplied by the app. They are not option ids the
agent knows about, so they are sent as `customText` and typed into the freeform
row, which the dialog accepts for a boolean field. `answerBodyFor` is the
single place that decides this, and it is what the unit tests pin down.

A question that wants prose renders no bar at all. There is nothing to tap, and
the composer already prompts for it.

The bar goes on standing after it is answered, because what removes it is the
bridge marking the request resolved — the agent's schedule, a poll interval
away at best. So it latches: once an answer is accepted the buttons stay shut
and the heading reads `ANSWER SENT`. Left live, a second tap either injects a
prompt the agent never asked for or is refused as an empty answer, depending
on whether a re-parse landed in between.

While the question is open the bar is its only rendering, so the question text
expands on tap. The bridge falls back to a schema field's `description` when
there is no `title`, and that is routinely long prose.

The composer's height is now measured rather than assumed. It was a fixed
spacer with a taller variant for the working row, and the bar made a third
size; a pending question, the working row and a wrapped draft all change it,
and a stale guess lets the composer cover the newest message.

Only Copilot sessions produce these requests. There is no equivalent normaliser
for Claude or Codex sessions in the bridge, so on those providers the bar never
appears and answering stays a matter of typing.

Herdr's `blocked` status is not this. It is pane-level detection that something
is waiting on a human, and it is set independently of any `ask_user` event — an
agent can be `blocked` with no structured request at all. The two must not be
wired together.

## Rules

- The bar is the control; the transcript is the record. Do not give the
  transcript row buttons.
- Read both `ask_user` shapes. A new one is a silent failure: the agent blocks
  and the app shows nothing.
- Answer the dialog with keys, never `agent.prompt`. Anchor against a clamped
  end rather than trusting where the cursor starts.
- Keep the bar keyed on the request id, so a new question does not inherit the
  previous one's half-made selection.
- An answered question stays answered until the bar is unmounted. Do not
  re-enable the buttons on the strength of the request still being open.
- Poll the conversation while the agent is `blocked` as well as `working`, but
  only until the question arrives. The question is written to the session log a
  moment after the status changes, so a single refresh on the change lands too
  early to see it; carrying on afterwards would poll for as long as the person
  takes to answer, which is unbounded.
