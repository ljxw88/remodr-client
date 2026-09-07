# ADR 012: Shared frosted material

Status: accepted; the current rim uses a native border, not an overlay.

[Decision index](README.md) | [Color tokens](../../COLOR.md)

## Context

Independent opaque fills and blur settings produced inconsistent surfaces over
the app's gradient. Android blur also requires explicit target/consumer
placement: a consumer sampling its own enclosing target can recurse in native
rendering and crash the process.

## Decision

Use [`GlassSurface`](../../src/components/ui/glass-surface.tsx) and its exported
`glassRim` style helper for ordinary surfaces.

| Tone | Intended position | Material |
| --- | --- | --- |
| `panel` | Directly on the canvas | Low-alpha fill and native rim |
| `chrome` | Over scrolling content | Backdrop blur plus tint when a target is available |

Without a target, chrome uses an opaque, window-aligned `CanvasFill` with a
light tint. That fallback hides underlying text; it does not provide real blur.
Skia hero/selection effects remain separate, scoped controls.

## Implementation constraints

`BlurBackdropTarget` includes the background gradient so the sampled subtree
has a complete backdrop. A `BlurView` must stay outside its own sampled target.
The tab shell provides a target for the dock. The agents stack opts in through
`RouteStack blurBackdrop`, and `ScrollEdgeFrame` provides the transcript target
when one is not already overhead.

The implementation uses `dimezisBlurViewSdk31Plus`. Android versions below API
31 use that method's non-blur fallback; do not describe all Android versions
as having identical blur.

`glassRim` returns `borderWidth`, `borderColor`, and `borderTopColor`. A native
border follows a resizing view without waiting for a separately measured
canvas or overlay. The old instruction to prefer overlay rims is superseded.

Padding for an absolutely positioned decorative child belongs on an inner
content view. `CanvasFill` aligns duplicated gradients with the window; a
gradient restarted below a header would create a seam.

Workflow pages use quiet content surfaces. The compact action menu has an
opaque base in its modal window and does not sample a target from the underlying
app window. Android scroll-edge treatment is a gradient fade, not cropped
backdrop blur. See [ADR 016](016-page-first-navigation.md).

## Rules

- Use the shared component/helper rather than duplicating ordinary materials.
- Keep blur targets and consumers in the correct relationship; do not nest
  opportunistic targets.
- Keep fades below floating controls. Their declaration order already places
  them over the scrollable content; do not add a redundant raised z-index.
- Do not add elevation/drop shadows to translucent glass surfaces.
- Measure a plain wrapper/child rather than putting layout measurement on the
  blur target.
- Retest the whole transcript when changing stack animation: outgoing-target
  blanking also occurs with `animation: 'none'`. Android blur-backed
  `RouteStack` roots become invisible in layout-effect teardown, before child
  targets are disposed, so native dismissal cannot draw black orphaned chrome.
  Setup restores visibility for effect replay. Ordinary renders, focus changes,
  and other platforms do not retire the root. This relies on cut navigation;
  entrance motion remains inside the destination.
