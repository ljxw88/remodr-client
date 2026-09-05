# Skia visual effects

[Documentation index](README.md) | [Decision](adr/011-skia-visual-effects.md)

Use Skia for the existing decorative controls, not for ordinary chat surfaces.
The current dependency is `@shopify/react-native-skia` 2.6.2; confirm it in
[`package.json`](../package.json) when changing an API.

## Implemented components

| Source | Use |
| --- | --- |
| [`liquid-glass-button.tsx`](../src/features/agents/liquid-glass-button.tsx) | New Agent/New Space control with glow, refraction and a metal orb |
| [`liquid-glass.tsx`](../src/components/ui/liquid-glass.tsx) | Rounded-rectangle shader for refraction, dispersion and sheen |
| [`chromatic-metal.tsx`](../src/components/ui/chromatic-metal.tsx) | Shader-backed metal appearance |
| [`liquid-glass-rim.tsx`](../src/components/ui/liquid-glass-rim.tsx) | Selection material for fixed-size controls |
| [`use-shader-clock.ts`](../src/hooks/use-shader-clock.ts) | Focus/foreground-aware animation clock |

The chat composer uses `GlassSurface` with a native border and backdrop blur.
It has no Skia-measured panel or animated rim. Its height changes as the draft
grows; a separately measured decorative canvas can lag that resize.

## Translating web designs

| Web technique | Available approach here |
| --- | --- |
| Backdrop refraction | Skia `BackdropFilter`, but only for content drawn in the same canvas |
| Turbulence/displacement | Skia filters or a runtime shader |
| GLSL fragment shader | Port the calculation to SkSL |
| `ResizeObserver` | Measure a React Native wrapper or use the installed Skia sizing API |
| Animation frame loop | Reanimated frame callback feeding shader uniforms |
| Blur behind native views | `expo-blur` with a valid target, not a Skia backdrop filter |

Apple's `expo-glass-effect` path does not supply native Liquid Glass on Android.
A web `backdrop-filter` or SVG displacement demo cannot directly sample native
views in this project.

## Canvas composition

A Skia backdrop filter reads what its canvas has already painted. Draw the
source, apply the clipped filter, then draw sharp foreground details. Splitting
source and effect across canvases does not create a native-view backdrop.

Displacement over a flat color produces no visible refraction. The existing
hero control supplies a glow for the shader to distort. It does not refract
the surrounding React Native transcript.

The installed Canvas defaults to P3. Existing effects explicitly pass
`colorSpace="srgb"` to match surrounding React Native colors.

## Shader conventions

- Runtime effects use `half4 main(float2 fragCoord)`.
- Shader-child sampling uses `image.eval(coord)`.
- Return premultiplied color for translucent output and preserve sampled alpha
  where the effect must not paint over the rest of the canvas.
- Use compile-time loop bounds for gradient ramps and avoid relying on dynamic
  array indexing. Recheck shader compiler support on the actual target before
  introducing a new construct.
- Compile with `Skia.RuntimeEffect.Make` and handle its null result explicitly.

The current gradient-ramp pattern uses a constant `STOPS`:

```glsl
half3 ramp(float t) {
  float x = clamp(t, 0.0, 1.0) * float(STOPS - 1);
  half3 c = half3(0.0);
  for (int i = 0; i < STOPS; i++) {
    float w = max(0.0, 1.0 - abs(x - float(i)));
    c += u_stops[i] * half(w);
  }
  return c;
}
```

The liquid-glass shader uses a rounded-rectangle signed distance field for
edge falloff. Its normal points outward, but the bend samples inward to avoid
pulling the surrounding background into the rim. Channel dispersion stays
small. The existing sheen uses `abs(n.y)` to light both horizontal edges.

For rim animation, transform the gradient rather than rotating the stroked
shape itself.

## Sizing and animation

Current components measure a plain `View` wrapper and size an absolute Canvas
from that measurement. Keep padding on an inner content view so the canvas
matches the outer border. Do not assume a web-style DPR calculation or the
deprecated Canvas `onLayout` behaves like wrapper layout.

`useShaderClock` has a stable frame callback, accumulates
`timeSincePreviousFrame`, and clamps gaps to 64 ms. It pauses when disabled,
unfocused, or backgrounded. Use shared values/derived uniforms instead of React
state updates for every frame.

Clip filters to the required area. Use `opaque` only when the entire canvas
really has an opaque background; applying it to transparent control overlays
changes compositing. Avoid continuously running clocks for hidden controls.

## Dependencies and iteration

Use `npx expo install @shopify/react-native-skia` when changing the dependency
so Expo can select its compatible version. The current project relies on the
Expo preset rather than a custom Babel plugin configuration.

Skia itself is [included in SDK 57 Expo Go](https://docs.expo.dev/versions/v57.0.0/sdk/skia/).
The remodr app still requires a development build because of its local
`RemoteCore` module.

Inspect representative states on an Android target: light/dark parts of the
gradient, different control sizes, selection, screen blur, and backgrounding.
Compare frames for continuity and watch for unexpected resets; identical
screenshots alone do not prove an animation reset because motion may be paused
or the sampled image may be unchanged.

Keep temporary previews and screenshots out of the committed app. Follow
[development checks](development.md#checks) for native dependency changes.
