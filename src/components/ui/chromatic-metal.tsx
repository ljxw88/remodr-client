import { Skia, Shader, RoundedRect, type SkRuntimeEffect } from '@shopify/react-native-skia';
import { useMemo } from 'react';
import { useDerivedValue, type SharedValue } from 'react-native-reanimated';

export type ChromaticMetalSettings = {
  /** 0 = square, 1 = circle (when the bounds are square). */
  rounding: number;
  /** Band contrast. Higher reads as harder chrome. */
  depth: number;
  /** Grain breaking up the bands. */
  roughness: number;
  /** Chromatic aberration between the R and B band samples. */
  rgbSplit: number;
  scale: number;
  stretch: number;
  /** Radians. */
  angle: number;
  repeats: number;
  offset: number;
  /** Speed of the sweeping phase. */
  phase: number;
  /** Speed of the cross-band warp. */
  evolution: number;
  /** Colour ramp as `#rrggbb` stops. */
  gradient: string[];
};

export const CHROME: ChromaticMetalSettings = {
  rounding: 1,
  depth: 0.5,
  roughness: 0.04,
  // Small: the three channels must stay close on the ramp, otherwise they land
  // on different luminances and the orb reads as a rainbow rather than metal.
  rgbSplit: 0.006,
  scale: 1.2,
  stretch: 1.2,
  angle: -0.55,
  repeats: 0.42,
  offset: 0,
  phase: 0.22,
  evolution: 0.5,
  // Dominantly dark with a single bright sweep, so the orb reads as a polished
  // sphere rather than a zebra pattern.
  gradient: ['#FAFAFA', '#525252', '#0A0A0A', '#8A8A8A', '#262626', '#000000'],
};

/**
 * SkSL forbids indexing a uniform array with a non-constant expression, so the
 * ramp is sampled by looping a constant number of times and accumulating a
 * triangular weight per stop rather than indexing by a computed position.
 */
function metalSource(stops: number): string {
  return `
uniform float2 u_center;
uniform float2 u_half;
uniform float  u_radius;
uniform float  u_time;
uniform float  u_scale;
uniform float  u_repeats;
uniform float  u_angle;
uniform float  u_stretch;
uniform float  u_rgbSplit;
uniform float  u_roughness;
uniform float  u_depth;
uniform float  u_offset;
uniform float  u_phase;
uniform float  u_evolution;
uniform half3  u_stops[${stops}];

const int STOPS = ${stops};

float hash(float2 p) {
  return fract(sin(dot(p, float2(127.1, 311.7))) * 43758.5453);
}

float noise(float2 p) {
  float2 i = floor(p);
  float2 f = fract(p);
  float2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + float2(1.0, 0.0));
  float c = hash(i + float2(0.0, 1.0));
  float d = hash(i + float2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

half3 ramp(float t) {
  float x = clamp(t, 0.0, 1.0) * float(STOPS - 1);
  half3 c = half3(0.0);
  for (int i = 0; i < STOPS; i++) {
    float w = max(0.0, 1.0 - abs(x - float(i)));
    c += u_stops[i] * half(w);
  }
  return c;
}

/** Seamless triangle wave, then contrast-sharpened so bands read as metal. */
float band(float coord) {
  float tri = abs(fract(coord) * 2.0 - 1.0);
  return clamp((tri - 0.5) * (1.0 + u_depth * 8.0) + 0.5, 0.0, 1.0);
}

float coordAt(float2 p) {
  float ca = cos(u_angle);
  float sa = sin(u_angle);
  float2 r = float2(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
  r.y *= max(u_stretch, 0.001);
  float d = r.x * u_scale;
  d += sin(r.y * 2.4 + u_time * u_evolution) * 0.35;
  d += (noise(r * 6.0 + u_time * 0.15) - 0.5) * u_roughness;
  return d * u_repeats + u_offset + sin(u_time * u_phase) * 0.5;
}

half4 main(float2 fragCoord) {
  float2 p = (fragCoord - u_center) / max(u_half.x, u_half.y);

  // Rim proximity drives the chromatic split, so fringes sit at the edge.
  float edge = clamp(length(p), 0.0, 1.0);
  float split = u_rgbSplit * (0.25 + 0.75 * edge * edge);

  float c = coordAt(p);
  half3 col = half3(
    ramp(band(c - split)).r,
    ramp(band(c)).g,
    ramp(band(c + split)).b
  );

  // A soft rim light keeps the sphere from reading flat, and a centre
  // darkening keeps foreground glyphs legible.
  float rim = pow(edge, 3.0);
  col += half3(half(rim * 0.22));
  col *= half(mix(0.42, 1.0, edge));

  return half4(col, 1.0);
}
`;
}

const cache = new Map<number, SkRuntimeEffect>();

function metalEffect(stops: number): SkRuntimeEffect {
  const cached = cache.get(stops);
  if (cached) {
    return cached;
  }
  const effect = Skia.RuntimeEffect.Make(metalSource(stops));
  if (!effect) {
    throw new Error('Chromatic metal shader failed to compile.');
  }
  cache.set(stops, effect);
  return effect;
}

function toRgb(color: string): [number, number, number] {
  const value = Skia.Color(color);
  return [value[0], value[1], value[2]];
}

type Props = {
  x: number;
  y: number;
  size: number;
  clock: SharedValue<number>;
  settings?: Partial<ChromaticMetalSettings>;
};

/**
 * Draws the shader into a rounded shape. Painting the shader as a child of the
 * shape is the cheapest mask; `<Mask>` would cost two extra save layers.
 */
export function ChromaticMetal({ x, y, size, clock, settings }: Props) {
  const config = useMemo(() => ({ ...CHROME, ...settings }), [settings]);
  const source = useMemo(() => metalEffect(config.gradient.length), [config.gradient.length]);
  const stops = useMemo(() => config.gradient.flatMap(toRgb), [config.gradient]);
  const half = size / 2;
  const center = { x: x + half, y: y + half };

  const uniforms = useDerivedValue(
    () => ({
      u_center: [center.x, center.y],
      u_half: [half, half],
      u_radius: half * config.rounding,
      u_time: clock.value / 1000,
      u_scale: config.scale,
      u_repeats: config.repeats,
      u_angle: config.angle,
      u_stretch: config.stretch,
      u_rgbSplit: config.rgbSplit,
      u_roughness: config.roughness,
      u_depth: config.depth,
      u_offset: config.offset,
      u_phase: config.phase,
      u_evolution: config.evolution,
      u_stops: stops,
    }),
    [center.x, center.y, half, config, stops],
  );

  return (
    <RoundedRect x={x} y={y} width={size} height={size} r={half * config.rounding}>
      <Shader source={source} uniforms={uniforms} />
    </RoundedRect>
  );
}
