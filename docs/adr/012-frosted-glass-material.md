# ADR 012: One frosted glass material

## Context

The interface had accumulated four ways of drawing the same idea. Chips and
cards used opaque greys (`backgroundElement`, `glassStrong`). The dock and the
chat composer used `expo-blur` with a hardcoded `rgba(25,27,32,0.82)` fill.
Sheets used a flat `chrome` grey. Each was tuned against the flat near-black
canvas the app used to have.

Once the canvas became an indigo-to-black gradient, those surfaces stopped
agreeing with each other. An opaque grey plate reads as a hole punched in the
gradient near the top of a screen and as nothing at all near the bottom, so the
same chip looked like two different controls depending on where it sat.

Two facts about `expo-blur` on Android shaped the options:

- A `BlurView` can only sample the subtree of a `BlurTargetView`. The canvas
  gradient was rendered at the root, outside every target, so the dock and
  composer were blurring transparent pixels. That is why the dock needed a
  hardcoded opaque fill to look like anything.
- A `BlurView` nested inside the target it samples makes that target's
  RenderNode contain itself. Android recurses through
  `RenderNode::prepareTreeImpl` until the native stack overflows and the
  process dies with SIGSEGV. There is no JS error and no red box.

## Decision

One material, expressed by one component: `GlassSurface`, with `GlassRim` for
pressables that need the material without an extra layout node.

The material has two families, chosen by what is behind the surface:

- **Panel** — on the canvas. A translucent white fill, a hairline rim, and a
  clipped specular top edge. No blur.
- **Chrome** — floating over scrolling content. A live backdrop blur through
  `BlurBackdropTarget`, plus a light fill.

Surface fills are white at low alpha rather than opaque grey, so a single token
works at both ends of the gradient.

`BlurBackdropTarget` renders its own copy of the canvas gradient, and frosted
chrome is always rendered as its sibling.

## Rationale

- Panels have nothing behind them but a smooth gradient. A blur pass there
  spends a frame to produce a picture indistinguishable from a plain fill, so
  the cost buys nothing. The glassiness comes from the rim and the highlight.
- Repointing `Colors.glass` and `Colors.glassStrong` to white alphas converted
  roughly twenty-five call sites without touching them, because they already
  referenced the tokens rather than literals.
- Duplicating the gradient inside the blur target costs one more fully covered
  `LinearGradient`. Hoisting all chrome to a root sibling position would have
  meant a portal, and moving the target to the root would have put every
  `BlurView` inside it — the crash.

## Consequences

Frosted chrome must be a sibling of `BlurBackdropTarget`, which constrains
screen layout: content goes inside the target, bars go beside it.

React Native modals render in their own window and cannot reach a blur target,
so sheets stay opaque. `Colors.chrome` is tinted toward the canvas indigo so an
opaque sheet still reads as the same family.

The scroll edge fade keeps its gradient-only treatment on Android. It sits over
the rows it softens, so it cannot be a sibling of the content it would blur.

On Android `intensity` sets the tint alpha *and* the blur radius, so the two
cannot be tuned independently without `blurReductionFactor`.

## Rules

- Use `GlassSurface` or `GlassRim`. Do not hand-roll a translucent fill plus a
  border.
- Never nest a `BlurView` inside the blur target it samples.
- Keep surface fills as white alphas, so they work at both ends of the canvas.
- Draw rims and highlights as overlays, not `borderWidth`, so they survive a
  blur tint and do not consume a caller's padding.
- Clip the specular highlight to the corner radius.
- Blur only where something is behind the surface worth blurring.
