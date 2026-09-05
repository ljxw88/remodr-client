# Page-based workflows

[Documentation index](README.md) | [Decision](adr/016-page-first-navigation.md)

Creation and editing use ordinary routes under `src/app/flows/`, not bottom
sheets. Short agent actions use an anchored menu; destructive operations still
ask for confirmation.

## Routes and ownership

| Route | Purpose |
| --- | --- |
| `new-agent` | Name, device, space, provider, model, and optional advanced settings |
| `new-space` | Space name and root path; continues to New Agent after creation |
| `devices`, `providers`, `spaces` | Scoped selection for an in-progress creation form |
| `folders` | Remote directory browser with explicit folder selection |
| `agent-settings` | Draft model/reasoning/context changes with explicit Apply |
| `models` | Searchable model catalog shared by creation and settings |
| `rename-agent` | Focused name-editing page |

[`FormPage`](../src/components/ui/form-page.tsx) owns page layout, header/back
behavior, keyboard handling and the fixed action footer.
`FormSection`/`SelectionRow` provide quiet grouped rows. There is no dock clearance
inside these forms because the dock is not present on the workflow route.

The flow stack uses a quiet background. Glass remains on navigation controls,
the dock, and the chat composer rather than every form section.

## Drafts and navigation

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

Model selection only changes the draft. Model/effort/context compatibility comes
from `agent-catalogue.ts`. Applying reasoning or context changes retains the
existing restart warning and explicit confirmation action.

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

Connection status remains a floating indicator with a small retry action.
Detailed connection state is on the server page; no reconnect sheet opens.
Structured agent questions remain beside the composer.
