# Skia visual effects

Practical notes for building shader-backed effects on Android with
`@shopify/react-native-skia`. Written after building the liquid glass
**New agent** button; see
[ADR 011](adr/011-skia-visual-effects.md) for why Skia rather than the
alternatives.

Most of the cost in that work was not the shader maths. It was the handful of
constraints below, each of which silently produces a plausible-looking wrong
result.

## Before starting

**Design prompts from Framer, Figma or the web do not port.** They assume a
DOM: CSS `backdrop-filter`, SVG `feTurbulence`/`feDisplacementMap` over the
backdrop, WebGL/GLSL, `ResizeObserver`, `requestAnimationFrame`. None of that
exists here. Translate each capability before agreeing to a design:

| Web technique | Android equivalent |
|---|---|
| SVG filter on the backdrop | Skia `BackdropFilter` |
| `feTurbulence` / `feDisplacementMap` | `Turbulence` / `DisplacementMap`, or a runtime shader |
| GLSL fragment shader | SkSL runtime shader |
| `ResizeObserver` × DPR | `onLayout` |
| `requestAnimationFrame` | Reanimated frame callback |
| CSS `filter: blur()` behind an element | `Blur` image filter inside the canvas |

Not available at all: `expo-glass-effect` is iOS 26+ and renders a plain view
on Android. Shiki-style WASM tooling cannot run on Hermes.

## The four constraints that shape every design

**1. A backdrop filter only sees its own canvas.** It reads what that `<Canvas>`
has already painted, never the React Native views behind it. Anything the
effect must distort has to be drawn earlier in the same canvas. Splitting the
effect and its backdrop across two canvases, or putting a React Native view
underneath, yields a filter with nothing to work on.

**2. A dark canvas has nothing to refract.** Displacement over flat colour is
invisible. On the near-black canvas the glass only reads because a glow is
drawn beneath it specifically to be bent. Budget for that content.

**3. Filter chains cannot do edge falloff.** `DisplacementMap`'s `scale` is one
scalar for the whole pass, so distortion cannot be strong at the rim and absent
in the centre. Anything edge-weighted — refraction, dispersion, "splay" — needs
a runtime shader with a signed distance field giving a per-pixel edge distance.

**4. Canvases default to the P3 colour space.** Hex constants written into SkSL
render more saturated than the same hex in a React Native view. Pass
`colorSpace="srgb"` when shader colour must match surrounding UI.

## SkSL rules worth memorising

Verified by compiling test programs, not inferred.

| Rule | Notes |
|---|---|
| `half4 main(float2 fragCoord)` | No `void main()`, no `gl_FragColor`, no `sk_FragCoord` |
| No `while` loops | `for` with a constant bound only |
| No `%` on integers | Use `mod()` |
| **No non-constant array indexing** | Stricter than WebGL 1. Even a local array with a runtime index fails |
| Shaders return premultiplied colour | Multiply RGB by A yourself for translucent output |
| `image.eval(coord)` | Not `texture()` or `sample()` |

The array rule bites whenever a shader takes a gradient. Sample a ramp by
looping a constant number of times and accumulating a weight per stop:

```glsl
half3 ramp(float t) {
  float x = clamp(t, 0.0, 1.0) * float(STOPS - 1);
  half3 c = half3(0.0);
  for (int i = 0; i < STOPS; i++) {
    float w = max(0.0, 1.0 - abs(x - float(i)));
    c += u_stops[i] * half(w);   // constant index inside an unrolled loop
  }
  return c;
}
```

## Mistakes that produce plausible-looking wrong results

Every one of these shipped before being caught by looking closely at a
screenshot. None of them error.

**Refracting outwards.** The SDF gradient points *out* of the shape, so bending
along it samples pixels from outside and drags the surrounding canvas in as a
dark rim. Sample towards the centre instead — which is also what a lens does.
The symptom reads as the fill being misaligned rather than as a shading bug.

**Rotating the shape instead of the gradient.** Wrapping a stroked shape in a
transformed `<Group>` rotates the geometry, so the outline stops matching the
element. Skia gradients accept their own `transform`; rotate the gradient and
leave the shape alone.

**Lighting one edge only.** A highlight keyed on `-n.y` lifts the top edge and
biases the whole body's luminance upwards, which also reads as an offset. Use
`abs(n.y)` unless the asymmetry is deliberate.

**Splitting colour channels too far.** Sampling R, G and B at widely separated
ramp positions lands them on different luminances, and metal turns into a
rainbow. Keep the split small so the channels stay neighbours and only fringe
at band edges.

## Animation

Drive uniforms from a Reanimated shared value through `useDerivedValue`, never
from React state — state re-renders the tree every frame.

**`useFrameCallback` re-registers whenever its callback identity changes, and
re-registering restarts its internal timer.** An inline closure is a new
identity on every render, so any re-render of the host screen rewinds the
animation to zero. Two habits avoid this permanently:

- keep the callback identity stable;
- accumulate `timeSincePreviousFrame` rather than reading `timeSinceFirstFrame`,
  so neither a re-render nor a pause can rewind the clock. Clamp long gaps so
  resuming does not jump.

`useShaderClock` in `src/hooks/` does both and pauses on blur and background.
Prefer it to Skia's `useClock`, which runs forever.

Note that React Compiler's `react-hooks/immutability` rule rejects mutating a
shared value that is also declared as a hook dependency. Shared values are
stable containers, so simply leave them out of the dependency list.

## Cost control

- Pass `opaque` on the canvas. It avoids the alpha-blend path and sidesteps a
  surface leak affecting non-opaque canvases.
- Always `clip` a backdrop filter to the region that needs it. It forces a
  save layer, and unclipped it re-processes everything drawn beneath.
- Stop the clock when the effect is disabled, off-screen, or backgrounded. A
  frame callback requests a frame every vsync indefinitely, keeping the GPU
  awake and blocking the display dropping to a lower refresh rate.
- Runtime shader image filters ignore device pixel ratio and soften their
  input. Supersample only if the result looks soft; it multiplies fill cost.

## Setup

Expo SDK 57 pins `@shopify/react-native-skia` at 2.6.2 — install with
`npx expo install` so that version is used. No config plugin and no Metro
changes are needed. `babel-preset-expo` auto-injects
`react-native-worklets/plugin`, so **do not** create a `babel.config.js` to add
it manually; doing so runs the plugin twice. A development build is required;
Skia cannot run in Expo Go.

## Iterating on a shader

Screenshots beat reasoning for this work — every mistake above was found by
looking, not by thinking harder.

1. Add a temporary preview route rendering the component in each state.
2. Build once (`npx expo run:android`), then rely on fast refresh.
3. `adb exec-out screencap -p > shot.png`, then `sips -c H W --cropOffset T L`
   and `sips -Z 900` to zoom. Subtle rim artefacts are invisible at 1×.
4. To prove an animation is running rather than resetting, capture two frames a
   fixed interval apart *after the same trigger*. Identical frames mean a reset;
   advanced frames mean it is continuous.
5. Delete the preview route before committing.

Watch logcat for `ReactNativeJS` errors while iterating: a failed SkSL compile
throws at `Skia.RuntimeEffect.Make`, which returns `null` rather than raising a
useful message on its own.

## Sizing a canvas

Measure a plain `View` wrapper, not the `Canvas`. Skia's `Canvas` accepts
`onLayout` but ignores it under Fabric, where it is deprecated in favour of
`onSize`. A canvas that never learns its size renders nothing, which looks
identical to a shader that compiled but drew nothing.

A canvas laid over a control with `position: absolute` is inset by that
control's padding, because Yoga positions absolute children against the
parent's padding box. Keep padding on an inner content view so the canvas can
trace the control's actual edge — `LiquidGlassButton` and `LiquidGlassRim`
both do this.
