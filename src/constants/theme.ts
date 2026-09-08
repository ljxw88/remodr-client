import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  text: '#FAFAFA',
  background: '#171717',
  // A 6.5% white plate over #171717 resolves near the reference #262626.
  backgroundElement: 'rgba(255,255,255,0.065)',
  // Selected content resolves near #373737 without introducing another hue.
  backgroundSelected: 'rgba(255,255,255,0.14)',
  textSecondary: '#B8B8B8',
  textMuted: '#A3A3A3',
  placeholder: '#A3A3A3',
  border: 'rgba(255,255,255,0.14)',
  accent: '#F5F5F5',
  accentSecondary: '#FF8000',
  danger: '#FF7A7A',
  success: '#7DD3A7',
  warning: '#F5C66A',
  onAccent: '#171717',
  onAccentSecondary: '#FFFFFF',
  // Sheets and menus render in their own window, so use an opaque-feeling
  // neutral veil rather than a hue borrowed from the old canvas.
  fog: 'rgba(10,10,10,0.72)',
  glass: 'rgba(255,255,255,0.065)',
  glassStrong: 'rgba(255,255,255,0.10)',
  glassBorder: 'rgba(255,255,255,0.14)',
  glassHighlight: 'rgba(255,255,255,0.22)',
  glassShadow: 'rgba(0,0,0,0.65)',
  accentSoft: 'rgba(245,245,245,0.14)',
  successSoft: 'rgba(125,211,167,0.16)',
  warningSoft: 'rgba(245,198,106,0.16)',
} as const;

/**
 * Frosted materials, in two families.
 *
 * `panel` is for controls that sit directly on the canvas — chips, header
 * buttons, cards. There is nothing behind them but the canvas, so blurring
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
    /**
     * The fill when there is no target and the surface carries its own opaque
     * copy of the canvas instead.
     *
     * Lighter than the panel tints, not heavier, even though it is doing more
     * work. The blur path lands somewhere near these values only after the
     * backdrop has been darkened by a dark material tint; here the copy comes
     * through at full strength, so the same alpha over it reads as a grey card
     * laid on the canvas rather than a surface the canvas shows through.
     */
    canvasFill: 'rgba(255,255,255,0.055)',
    canvasFillStrong: 'rgba(255,255,255,0.075)',
  },
} as const;

/**
 * Fades at the edges of scrollable regions, so rows dissolve into the canvas
 * instead of ending at a hard clipping line behind the dock or composer.
 *
 * Tune here. `bottomHeight` sets how far up the dissolve reaches and
 * `bottomOpacity` how completely it hides content at the very edge. Set an
 * opacity to 0 to disable that edge.
 */
export const ScrollEdgeFade = {
  /** Colour content dissolves into. Match the canvas. */
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

/** Shared by device/space filters and conversation activity disclosures. */
export const ChipGeometry = {
  minHeight: 38,
  paddingHorizontal: Spacing.one + Spacing.half,
  gap: Spacing.half,
} as const;

/**
 * The three heights a control is built to.
 *
 * Three, so that a panel reads as a set of related things rather than a ladder
 * of near-misses. Before this, one sheet stacked a 36, a 46, a 48, a 58 and a
 * 64 on top of each other, and not one of those gaps was a decision anybody
 * had made.
 *
 * Each is a minimum, never a fixed size: at a large font scale the content
 * grows past it rather than being clipped by it.
 */
export const ControlHeight = {
  /** A chip, an icon tile, or a button tucked inside another control. */
  compact: 36,
  /** A button, a text field, or a row of a single line. */
  regular: 44,
  /** A row carrying an icon, or a name with a second line under it. */
  row: 56,
  /**
   * The home header's pair — the New agent button and the round button beside
   * it.
   *
   * Deliberately off the scale above, which is for controls sharing a panel
   * with their neighbours. These two are the screen's opening move and stand
   * alone, so they are drawn larger. They share a number because they sit on
   * one line and would read as a mistake at different heights.
   */
  header: 50,
} as const;

export const MaxContentWidth = 1200;
export const MaxFormWidth = 600;
