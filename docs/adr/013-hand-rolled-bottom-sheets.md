# ADR 013: Hand-rolled bottom sheets

## Context

Four screens present bottom sheets. They are built on React Native's `Modal`
with the legacy `Animated` API: a scrim whose opacity follows one animated
value, and a panel that measures itself and slides its own height.

The obvious question is whether that should be a library instead.

`@gorhom/bottom-sheet` is the ecosystem default by download share. Its peer
ranges do formally admit this stack, but it is developed against React Native
0.76, React 18.3, and Reanimated 3.19 — not 0.86, 19, and 4.5. It has shipped
nothing since May 2026 while carrying an open Android bug reported against
almost exactly our versions, in which animated reactions never fire when the JS
thread is busy at mount.

`@expo/ui` is the more interesting option. It is already in `node_modules` via
`expo-router` and already autolinked into the Android build, so its Jetpack
Compose sheet is compiling into the APK whether we use it or not. It offers a
native Material 3 `ModalBottomSheet` and an explicitly API-compatible drop-in
for `@gorhom/bottom-sheet`.

## Decision

Keep the hand-rolled sheet.

## Rationale

- The native Android sheet supports two resting states, partial and expanded.
  Our sheets are single-height panels sized by their content, so we would be
  working against the component rather than with it.
- The drop-in explicitly ignores custom backdrops, handles, and animation
  configuration; they are accepted for API compatibility and change nothing.
  The rim, corner radius, chrome tint, and scrim are the whole reason these
  sheets look like the rest of the app.
- What a library would buy us is drag-to-dismiss, snap points, keyboard
  avoidance, and scroll-gesture coordination. We use none of the four.
- `@gorhom/bottom-sheet` would also require a `GestureHandlerRootView` at the
  app root, which this app does not have — `react-native-gesture-handler` is
  present only because `expo-router` depends on it.
- Owning the exit animation is not a workaround for a React Native quirk. It is
  what Google's own Compose guidance prescribes — hide, then remove from
  composition in the completion callback — and what Expo's native sheet does,
  where `hide()` resolves after the dismiss animation. React unmounts
  synchronously; something has to defer it.

## Consequences

The grab handle is decorative. Material treats a drag handle as the accessible
substitute for the drag gesture, with expand and collapse actions attached, so
showing one without gestures is an affordance that does not pay out. It stays
because it reads as the standard shape for "this is a sheet", and because ours
is a plain view that screen readers never reach, so nobody is actively misled.
If sheets ever gain drag-to-dismiss, this is the control to attach it to.

Legacy `Animated` has no reduced-motion support of any kind, unlike Reanimated,
where every animation honours the system setting by default. We read the
setting ourselves. Nothing else about the two APIs matters here: opacity and
translate both run on the native driver already, so Reanimated would move the
work to a different thread rather than a faster one.

Revisit `@expo/ui` around SDK 58. It costs nothing to prototype since the
native code already ships, and the case against it is about today's constraints
rather than the idea.

## Rules

- Every dismissal goes through the `close` the sheet hands its children, so the
  exit always plays.
- The exit must survive interruption: a re-layout must not restart the entrance
  mid-close, and the close callback must fire however the animation ends.
- Do not add a gesture library for sheets without adding the gestures.
- A control inside a sheet takes its height from `ControlHeight` in
  `constants/theme.ts`, and its horizontal inset from the panel rather than
  from its own content style. Three of those heights apply here, on purpose:
  `compact` for a chip, an icon tile or a button tucked inside another control,
  `regular` for a button, a text field or a single-line row, and `row` for a
  row carrying an icon or a second line. (`header` is the home screen's opening
  pair and has no business in a sheet.) A fourth number in here is how one
  sheet ended up stacking a 36, a 46, a 48, a 58 and a 64 that no one had
  chosen.
- Pair a minimum height with vertical padding small enough that the minimum is
  what governs at the default font scale. Padding that already exceeds it makes
  the token decorative and the row a few points taller than its neighbours.
- An icon-only control may sit at `regular` rather than Android's 48dp minimum
  target, but only with `hitSlop` making up the difference.
