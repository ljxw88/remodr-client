# ADR 016: Page-first workflows and contextual menus

Status: accepted; supersedes [ADR 013](013-hand-rolled-bottom-sheets.md).

[Decision index](README.md) | [Current workflow guide](../form-workflows.md)

## Context

One sheet component was used for long creation forms, model catalogs, folder
browsing, and short actions. Long lists and nested selection steps made those
panels cumbersome, while simple actions inherited excessive space and a heavy
modal backdrop.

## Decision

Move creation, browsing, settings and rename flows to ordinary routes. Use a
searchable model list, grouped selection rows, and collapsed optional settings.
Use a small anchored menu for agent actions. Keep native confirmations for
destructive actions and host trust.

Connection recovery remains automatic with floating status and server-page
details. Questions remain next to the composer. Remove unused sheet machinery.

## Consequences

Draft ownership is explicit and shared across route selectors. Cancel and Back
do not apply settings. Creation stays bound to the device chosen in the form.

Mobile keyboard handling is shared by form pages: measure actual occlusion,
keep the action footer visible, reveal focused fields, and avoid double insets
when Android already resizes the window.

Glass is retained for functional floating controls, not used as the background
of every form. No animated borders or canvas-measured decorative rims are
introduced.
