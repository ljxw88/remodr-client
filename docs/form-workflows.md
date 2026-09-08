# Page-based workflows

[Documentation index](README.md) | [Decision](adr/016-page-first-navigation.md)

Creation and editing use ordinary routes under `src/app/flows/`, not bottom
sheets. Short agent actions use an anchored menu; destructive operations still
ask for confirmation.

## Agent list ordering

The selected device's agents are ordered by newest observed output, within their
workspace groups. In **All spaces**, the workspace containing the newest output
moves to the top as well. Device/space selections and the order of filter chips
are unchanged, and refreshes do not force the scroll position back to the top.

While the agent list is focused, foregrounded and connected, it refreshes output
activity immediately and then two seconds after each completed request, without
overlapping polls. Transcript-backed providers use the current session's file
last-write time; raw-terminal providers are promoted when their observed output
text changes. Existing status/title order is the fallback for unknown or equal
activity. Known-session recency survives reconnect snapshots, but is not carried
into a replacement provider session.

## Unread finish indicators

A blue dot marks a completed agent whose finish has not been viewed in this app.
Workspace headers and filter chips aggregate their agents; device chips on the
Agents page aggregate their device. The Servers page shows connection status
only. **All spaces** and the collapsed-filter
control make unread work discoverable outside the current space/device filter.
Aggregates show a count when more than one agent has unread finished work.
These dots are separate from running/done and SSH connection status.

Completed sessions receive a marker on first discovery. Read state is persisted
with the session and does not reset on ordinary snapshots, reconnects, or app
restarts. Native status revisions distinguish subsequent finishes in the same
session, including work that starts and ends between snapshots. Older bridges
without revisions use observed status transitions instead.

Selecting a device or space does not acknowledge anything. A successful
conversation refresh while that conversation is focused and foregrounded clears
only the finish captured at the start of the read. A newer finish arriving during
that read stays unread until its own refresh. Background prefetches, failed reads,
and cached/offline views do not clear the marker. Read-state storage failures
restore the dot and surface an error.

This is an in-app notification, not an operating-system push notification, and
does not add notification permissions or a background service.

## Routes and ownership

| Route | Purpose |
| --- | --- |
| `new-agent` | Name, device, space, provider, model, and optional advanced settings |
| `new-space` | Space name and root path; continues to New Agent after creation |
| `devices`, `providers`, `spaces` | Scoped selection for an in-progress creation form |
| `folders` | Remote directory browser with explicit folder selection |
| `agent-settings` | Model Settings: draft model/reasoning/context changes with explicit Apply |
| `models` | Searchable model catalog shared by creation and settings |
| `rename-agent` | Focused name-editing page |

[`FormPage`](../src/components/ui/form-page.tsx) owns page layout, header/back
behavior, keyboard handling and the fixed action footer.
`FormSection`/`SelectionRow` provide quiet grouped rows. There is no dock clearance
inside these forms because the dock is not present on the workflow route.

The flow stack uses a quiet background. Glass remains on navigation controls,
the dock, and the chat composer rather than every form section.
Static page titles use Title Case; user-supplied agent names keep their original casing.

## Drafts and navigation

`RouteStack` applies the shared 200ms, 16dp arrival motion to page changes and Back,
including returning from another stack. Header and content move together over an
opaque canvas; native stack transitions remain disabled to avoid overlapping
screens and blank blur targets. The stable navigator layout preserves mounted
forms, while field edits and keyboard changes never restart the animation.
Direction is prepared from route state, but motion waits for native appearance
(`transitionEnd` with `closing: false`), since JS focus precedes the actual
Android fragment swap. Stale, duplicate, and closing events are ignored.

[`flow-drafts.ts`](../src/features/forms/flow-drafts.ts) stores in-progress form
values. Routes pass a `flowId`, not callbacks or serialized object graphs.
Base pages and selectors retain that same draft; Back from a selector preserves
all editing values. Leaving the workflow releases the draft.
Successful forms stay locked until navigation finishes; let route cleanup release
their draft rather than displaying an expired-form state before the next page mounts.

These form drafts are in memory, not the durable chat outbox. An expired or
unavailable flow displays an explicit recovery page. Cancelling settings or a
rename does not modify the server.

Creation captures a device ID. Repository creation methods accept that explicit
target, so switching global selection cannot send the form to another device.
Successful creation updates the shared workspace filter without route callbacks.
Creating a space commits that space before the next New Agent step; cancelling
the agent step does not delete the space.
Folder selection uses only a successfully loaded path. Editing the address disables
selection until Go opens it, so a stale listing cannot select the wrong folder.

The picker and file manager render the same
[`RemoteFileExplorer`](../src/features/files/remote-file-explorer.tsx), using the
New Space form interface for the path field, Up/Go controls, rows, skeletons and
errors. Folder selection is an optional footer; creation and long-press deletion
are file-manager capabilities supplied by its route adapter, not a second explorer.
Both use [`useRemoteDirectory`](../src/features/files/use-remote-directory.ts). Entries,
loading and errors belong to one host/session/path request. Navigation and retry
invalidate the previous request immediately; blur/unmount discards late results,
and refocus/reconnection starts a fresh read. Both successful and failed responses
recheck the live native session before affecting the visible listing. A detected
session mismatch refreshes native session observers and surfaces a connection
error rather than leaving a permanent loading state.

Create/delete remain file-manager actions. Their captured request tokens prevent
late completions from refreshing a different directory, and stale delete or
folder-selection confirmations cannot act on a replacement view/session.
Creating a folder does not clear a newer name typed while it was in flight.
The file manager distinguishes loading, read failure with retry, and a genuinely
empty directory; a failed post-mutation listing is not reported as a failed
mutation.

Model selection only changes the draft. Model/effort/context compatibility comes
from the [per-provider JSON catalogues](model-catalogues.md), through
`agent-catalogue.ts`. Model selection at creation is available for Copilot,
OpenCode, Codex, and Claude Code. OpenCode is the preferred first provider when
available; a deliberate user selection is retained when it remains valid.
Live Model Settings require a client
implementation (currently Copilot only) and the agent's reported retuning
capability. An explicit `false` disables entry and Apply; an omitted field keeps
legacy Copilot behavior. Availability is read from the current runtime, not
captured in the form draft, and is checked again when submitting. Draft edits
survive a capability or connection change. Applying reasoning or context changes
retains the existing restart warning and explicit confirmation action.

## Mobile keyboards

`useKeyboardOverlap` compares the measured viewport bottom with the native
keyboard frame. If Android `adjustResize` already shortened the viewport,
the additional overlap is zero. Do not add raw keyboard height, another
`KeyboardAvoidingView`, or automatic scroll insets on top of that calculation.

The footer is a sibling of the scrollable form body and remains above the
keyboard. `TextField` forwards focus to the form's scroll context so a lower
field can be revealed above both keyboard and footer. Scrollable selectors
must use `keyboardShouldPersistTaps="handled"` so selecting a row works on the
first tap while search is focused.

Fields support `editable`, `autoFocus`, `returnKeyType`, `onSubmitEditing`,
`maxLength`, `multiline`, and `selectTextOnFocus`. Use these deliberately: name/path entry
must not be obscured, and keyboard submission must use the same guarded
validation/action as the visible button.

Busy mutations disable form editing and back/swipe dismissal. Read-only folder
requests remain cancellable. Confirm keyboard behavior on Android after changing
the page, footer, or field geometry.
The root `flows` route disables its own native swipe gesture: a nested page cannot
control that parent gesture. Use the form's Back control to leave the workflow;
inner selector pages keep their ordinary back navigation.

Server creation/editing and credential entry also use this page layout.
Private-key input preserves newlines; the password keyboard action uses the
same guarded Connect operation as the footer.

## Contextual controls

`ActionMenu` anchors a compact menu to the chat's ellipsis. It supports outside
tap and system Back without a full-screen dimming layer. Menu actions navigate
to editing pages or request a destructive confirmation.
The composer's single model button displays the current model's catalogue label
(the raw identifier for unknown models, or **Auto** when none is reported).
It opens **Model Settings** for providers that support live retuning. Long labels
truncate without displacing Send; the accessibility label retains the full name.

Connection status remains a floating indicator with a small retry action.
Detailed connection state is on the server page; no reconnect sheet opens.
Structured agent questions remain beside the composer.

Chat uses `use-conversation-scroll.ts` to follow both message updates and
their later native layout measurements. Sending text or an answer resumes
following; manual history scrolling pauses it. The composer's **Latest**
control resumes following without changing the draft. Native visible-content
anchoring stays configured throughout the conversation to avoid stale anchor
geometry on iOS. Explicit following runs after data and native layout updates;
when reading history, only native anchoring adjusts the reader's position.
