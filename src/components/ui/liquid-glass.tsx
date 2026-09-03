import {
  BackdropFilter,
  Blur,
  RuntimeShader,
  Skia,
  type SkRuntimeEffect,
} from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { useDerivedValue } from 'react-native-reanimated';

export type LiquidGlassSettings = {
  /** Specular sheen along the lit edge. */
  light: number;
  /** Distortion strength, in pixels of displacement at the rim. */
  refraction: number;
  /** Apparent thickness. Controls how far in from the rim the bend reaches. */
  depth: number;
  /** Per-channel spread producing the rainbow fringe. */
  dispersion: number;
  /** Backdrop blur radius. */
  frost: number;
  /** Edge falloff. Higher concentrates the distortion at the border. */
  splay: number;
};

export const LIQUID_GLASS: LiquidGlassSettings = {
  light: 0.18,
  refraction: 14,
  depth: 22,
  dispersion: 0.55,
  frost: 3,
  splay: 1,
};

/**
 * Refraction has to happen in a runtime shader rather than a DisplacementMap
 * filter chain: `scale` there is a single scalar for the whole filter, so the
 * distortion cannot fall off towards the centre. Here the rounded-rect SDF
 * gives a per-pixel edge distance, which drives both the bend and the
 * per-channel dispersion.
 */
const SOURCE = `
uniform shader image;
uniform float2 u_center;
uniform float2 u_half;
uniform float  u_radius;
uniform float  u_light;
uniform float  u_refraction;
uniform float  u_depth;
uniform float  u_dispersion;
uniform float  u_splay;

float sdRoundRect(float2 p, float2 b, float r) {
  float2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

float2 surfaceNormal(float2 p, float2 b, float r) {
  float e = 1.0;
  float dx = sdRoundRect(p + float2(e, 0.0), b, r) - sdRoundRect(p - float2(e, 0.0), b, r);
  float dy = sdRoundRect(p + float2(0.0, e), b, r) - sdRoundRect(p - float2(0.0, e), b, r);
  float2 g = float2(dx, dy);
  float len = length(g);
  return len > 0.0001 ? g / len : float2(0.0);
}

half4 main(float2 fragCoord) {
  float2 p = fragCoord - u_center;
  float sd = sdRoundRect(p, u_half, u_radius);
  if (sd > 0.0) {
    return image.eval(fragCoord);
  }

  float thickness = max(u_depth, 1.0);
  // 0 at the rim, 1 deep inside: the centre stays almost undistorted.
  float inward = clamp(-sd / thickness, 0.0, 1.0);
  float edge = pow(1.0 - inward, max(u_splay, 0.001) * 3.0);

  float2 n = surfaceNormal(p, u_half, u_radius);
  // Sample towards the centre, not outwards. The normal points out of the
  // shape, so bending along it would read pixels from outside the pill and
  // drag the surrounding canvas in as a dark crescent along the rim.
  float2 bend = -n * u_refraction * edge;

  // Red bends least and blue most, so the fringe only appears where the
  // surface is steep.
  float spread = u_dispersion * edge;
  half4 centre = image.eval(fragCoord + bend);
  half r = image.eval(fragCoord + bend * (1.0 - spread)).r;
  half b = image.eval(fragCoord + bend * (1.0 + spread)).b;
  half3 col = half3(r, centre.g, b);

  // Colours are premultiplied, so the highlight is scaled by alpha and the
  // sampled alpha is preserved. Returning an opaque result here would paint
  // over whatever sits behind the canvas.
  float sheen = u_light * pow(abs(n.y), 2.0) * edge;
  col += half3(half(sheen)) * centre.a;

  return half4(col, centre.a);
}
`;

let cached: SkRuntimeEffect | null = null;

function glassEffect(): SkRuntimeEffect {
  if (!cached) {
    cached = Skia.RuntimeEffect.Make(SOURCE);
    if (!cached) {
      throw new Error('Liquid glass shader failed to compile.');
    }
  }
  return cached;
}

type Props = {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  settings?: Partial<LiquidGlassSettings>;
};

/**
 * Refracts whatever this canvas has already drawn. Skia's backdrop filter
 * reads the current layer, not the React Native views behind the canvas, so
 * the content to be warped must be rendered earlier in the same `<Canvas>`.
 */
export function LiquidGlass({ x, y, width, height, radius, settings }: Props) {
  const config = useMemo(() => ({ ...LIQUID_GLASS, ...settings }), [settings]);
  const source = glassEffect();
  const clip = useMemo(
    () => Skia.RRectXY(Skia.XYWHRect(x, y, width, height), radius, radius),
    [x, y, width, height, radius],
  );

  const uniforms = useDerivedValue(
    () => ({
      u_center: [x + width / 2, y + height / 2],
      u_half: [width / 2, height / 2],
      u_radius: radius,
      u_light: config.light,
      u_refraction: config.refraction,
      u_depth: config.depth,
      u_dispersion: config.dispersion,
      u_splay: config.splay,
    }),
    [x, y, width, height, radius, config],
  );

  return (
    <BackdropFilter
      clip={clip}
      filter={
        <RuntimeShader source={source} uniforms={uniforms}>
          <Blur blur={config.frost} mode="clamp" />
        </RuntimeShader>
      }
    />
  );
}
