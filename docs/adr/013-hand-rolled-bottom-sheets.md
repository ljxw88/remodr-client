# ADR 013: Project-owned bottom sheets

Status: superseded by [ADR 016](016-page-first-navigation.md).

[Decision index](README.md) | [Historical implementation](https://github.com/ljxw88/remodr-client/blob/86814c7/src/components/ui/sheet.tsx)

This records the earlier sheet implementation. Creation and editing now use
page workflows; see the [current guide](../form-workflows.md).

## Context

The app needs content-sized modal panels with its own scrim, tint, corner
radius, and exit behavior. A sheet library would need to preserve those
requirements while adding enough value to justify migration.

## Decision

The earlier implementation used `SheetModal` and `SheetPanel`, built on React Native `Modal` and native-driver
`Animated` transforms/opacity.

The modal window uses `animationType="none"`. The scrim fades independently of
the panel's vertical motion, and the panel remains mounted through its exit.

## Consequences

There are no draggable snap points or drag-to-dismiss gesture. The handle is
decorative; dismissal is through labelled close controls, scrim, or system
back. Content scrolling is handled by each sheet's children.

The implementation has explicit busy handling, nested-step dismissal
interception, and optional keyboard avoidance. It reads reduced-motion settings
itself. It does not rely on `Animated` automatically applying them.

Measured panel height controls travel distance. A layout change during closing
must not restart the entrance, and the close callback must run even if the exit
animation is interrupted.

Reevaluate a library when the product actually needs gesture/snap coordination.
Old comparisons of competitor release dates and peer versions are not a
current compatibility matrix.

## Rules

- Use the `close` callback supplied by the sheet for dismissals that need an
  animated exit. Do not unmount the panel before that exit finishes.
- Respect busy state and nested dismissal handling.
- Keep the modal panel opaque and do not sample a blur target from another
  native window.
- Use `ControlHeight`/spacing tokens from
  [`theme.ts`](../../src/constants/theme.ts) for controls.
- Ensure minimum heights are not accidentally exceeded by padding, and provide
  sufficient hit area for icon-only controls.
