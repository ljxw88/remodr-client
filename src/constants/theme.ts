import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  text: '#F5F6F8',
  background: '#08090B',
  // Frosted surfaces are white at low alpha rather than opaque grey, so they
  // pick up the canvas: a light panel over the indigo, and roughly the old
  // near-black grey where the gradient bottoms out.
  backgroundElement: 'rgba(255,255,255,0.07)',
  backgroundSelected: 'rgba(255,255,255,0.13)',
  textSecondary: '#B2B6C0',
  textMuted: '#7F8591',
  placeholder: '#6C727D',
  border: 'rgba(255,255,255,0.12)',
  accent: '#6C7CFF',
  danger: '#FF716B',
  success: '#5BE49B',
  warning: '#FFC65C',
  onAccent: '#FFFFFF',
  // Sheets and menus render in their own window, so they cannot blur the app
  // behind them. Tinted toward the canvas indigo instead, so an opaque surface
  // still reads as part of the same material family.
  chrome: '#161926',
  fog: 'rgba(6,7,10,0.55)',
  // Panel glass: a translucent white plate rather than an opaque grey one, so
  // controls pick up whatever the canvas is doing behind them.
  glass: 'rgba(255,255,255,0.07)',
  glassStrong: 'rgba(255,255,255,0.10)',
  glassBorder: 'rgba(255,255,255,0.16)',
  glassHighlight: 'rgba(255,255,255,0.22)',
  glassShadow: 'rgba(0,0,0,0.58)',
  accentSoft: 'rgba(108,124,255,0.22)',
  successSoft: 'rgba(91,228,155,0.16)',
  warningSoft: 'rgba(255,198,92,0.16)',
} as const;

/**
 * Frosted materials, in two families.
 *
 * `panel` is for controls that sit directly on the canvas — chips, header
 * buttons, cards. There is nothing behind them but the gradient, so blurring
 * would cost a render pass to produce an identical picture. They are a
 * translucent fill plus a rim, and that is enough to read as glass.
 *
 * `chrome` is for bars that float over scrolling content — the dock, the
 * composer. Here the blur is doing real work, so these get a live backdrop
 * blur and only a light fill on top of it.
 *
 * On Android `intensity` drives the tint alpha *and* the blur radius
 * (`intensity / blurReductionFactor`), so the two are tuned together: a low
 * intensity with a low reduction factor buys a wide blur without smoking the
 * surface over. Keep the radius at or under 25 — Dimezis clamps above that.
 */
export const GlassMaterial = {
  panel: {
    fill: Colors.glass,
    fillStrong: Colors.glassStrong,
    border: Colors.glassBorder,
    highlight: Colors.glassHighlight,
  },
  chrome: {
    /** Blur radius 40/1.7 ≈ 23. Tint alpha 255 x 0.40 x 0.55 ≈ 0.22. */
    intensity: 40,
    blurReductionFactor: 1.7,
    tint: 'systemUltraThinMaterialDark',
    fill: 'rgba(255,255,255,0.05)',
    /** Blur radius 54/2.2 ≈ 25. Tint alpha 255 x 0.54 x 0.70 ≈ 0.38. */
    intensityStrong: 54,
    blurReductionFactorStrong: 2.2,
    tintStrong: 'systemThinMaterialDark',
    fillStrong: 'rgba(255,255,255,0.04)',
  },
} as const;

/**
 * App canvas. A saturated indigo at the top falls away to the near-black
 * `background` well before the lower third, so content lower on a screen still
 * sits on a neutral surface.
 */
export const BackgroundGradient = {
  colors: ['#2E3BE0', '#232C9E', '#0E1130', Colors.background] as const,
  locations: [0, 0.28, 0.58, 1] as const,
};

/**
 * Fades at the edges of scrollable regions, so rows dissolve into the canvas
 * instead of ending at a hard clipping line behind the dock or composer.
 *
 * Tune here. `bottomHeight` sets how far up the dissolve reaches and
 * `bottomOpacity` how completely it hides content at the very edge. Set an
 * opacity to 0 to disable that edge.
 */
export const ScrollEdgeFade = {
  /** Colour content dissolves into. Match the foot of the canvas gradient. */
  color: Colors.background,
  topHeight: 18,
  topOpacity: 0.16,
  bottomHeight: 112,
  bottomOpacity: 0.92,
};

/** `#rrggbb` plus an alpha, as an `rgba()` string. */
export function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export type ThemeColor = keyof typeof Colors;

export const Fonts = {
  regular: 'Inter_400Regular',
  medium: 'Inter_500Medium',
  semibold: 'Inter_600SemiBold',
  mono: Platform.select({ ios: 'ui-monospace', default: 'monospace' }) ?? 'monospace',
};

export const Radius = {
  tag: 10,
  control: 18,
  glass: 24,
  pill: 999,
} as const;

export const Spacing = {
  half: 4,
  one: 8,
  two: 16,
  three: 24,
  four: 32,
  five: 48,
} as const;

export const MaxContentWidth = 1200;
