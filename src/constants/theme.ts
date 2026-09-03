import '@/global.css';

import { Platform } from 'react-native';

export const Colors = {
  text: '#F5F6F8',
  background: '#08090B',
  backgroundElement: '#141519',
  backgroundSelected: '#202229',
  textSecondary: '#B2B6C0',
  textMuted: '#7F8591',
  placeholder: '#6C727D',
  border: '#252830',
  accent: '#6C7CFF',
  danger: '#FF716B',
  success: '#5BE49B',
  warning: '#FFC65C',
  onAccent: '#FFFFFF',
  chrome: '#1B1D22',
  abyss: '#050506',
  fog: '#101114',
  glass: 'rgba(24,26,31,0.74)',
  glassStrong: 'rgba(28,30,36,0.92)',
  glassBorder: 'rgba(255,255,255,0.10)',
  glassShadow: 'rgba(0,0,0,0.58)',
  accentSoft: 'rgba(108,124,255,0.16)',
  successSoft: 'rgba(91,228,155,0.14)',
  warningSoft: 'rgba(255,198,92,0.14)',
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
  six: 80,
} as const;

export const MaxContentWidth = 1200;
