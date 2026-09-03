# ADR 011: Skia for visual effects

## Context

The **New agent** control was specified from a design produced for the web:
refraction through an SVG displacement filter applied to the backdrop,
chromatic dispersion at the edges, and a chrome shader driven by WebGL.

React Native has no DOM, so none of that is directly available. There is no
CSS `backdrop-filter`, no `<canvas>` WebGL context, and `react-native-svg`
filters apply to SVG content rather than to whatever is rendered behind a view.
`expo-glass-effect` wraps Apple's native glass and renders a plain view on
Android, which is the only platform this product ships.

The realistic options were to approximate the effect with layered gradients and
`expo-blur`, to run a genuine WebGL context through `expo-gl`, or to use Skia.

## Decision

Build shader-backed visual effects with `@shopify/react-native-skia`, at the
version Expo SDK 57 already pins.

Compose each effect inside a single `<Canvas>`: the content to be distorted
first, then the filter, then any sharp foreground. Express edge-weighted
behaviour in an SkSL runtime shader rather than a filter chain.

Treat these effects as scoped exceptions to the flat surface rules in
`DESIGN.md`, applied to individual hero controls rather than to the canvas.

## Reasons

- Skia is already a first-party Expo dependency, so it introduces a pinned
  and supported native module rather than an unvetted one.
- It provides direct equivalents for the whole design vocabulary: runtime
  shaders, displacement, turbulence, blur, and a backdrop filter.
- SkSL is close enough to GLSL that shader work transfers, unlike an
  approximation built from gradients, which cannot express refraction at all.
- `expo-gl` would supply real WebGL but would mean owning a render loop,
  surface sizing, and context loss for what is a small decorative surface.

## Consequences

Effects and the content they distort must live in the same canvas. A backdrop
filter cannot reach React Native views behind it, so layout is constrained by
the effect.

On a near-black canvas an effect needs content drawn specifically to be
distorted, or it renders as nothing.

Skia requires a development build and adds native code to the app. Animated
shaders keep the GPU awake, so every effect needs an explicit lifecycle.

## Rules

- Draw the distorted content and the filter in one canvas.
- Clip backdrop filters to the region that needs them.
- Mark effect canvases `opaque` where the background allows it.
- Stop shader clocks when the effect is disabled, unfocused, or backgrounded.
- Never index an array with a non-constant expression in SkSL.
- Verify effects from screenshots on a device, not from reasoning.
- Keep effects on individual controls; do not spread them across the canvas.
