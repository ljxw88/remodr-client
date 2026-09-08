import app from '../../app.json';
import { Colors } from './theme';

function channel(value: number) {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string) {
  const value = hex.slice(1);
  const [red, green, blue] = [0, 2, 4].map((offset) =>
    channel(Number.parseInt(value.slice(offset, offset + 2), 16)));
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrast(first: string, second: string) {
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

describe('graphite theme', () => {
  it('uses the requested exact canvas across routes and native startup', () => {
    expect(Colors.background).toBe('#171717');
    expect(Colors.accentSecondary).toBe('#FF8000');
    expect(app.expo.backgroundColor).toBe('#171717');
    expect(app.expo.plugins[1][1].backgroundColor).toBe('#171717');
  });

  it('keeps primary text, secondary text, actions and statuses accessible on the canvas', () => {
    for (const color of [
      Colors.text,
      Colors.textSecondary,
      Colors.accent,
      Colors.accentSecondary,
      Colors.success,
      Colors.warning,
      Colors.danger,
    ]) {
      expect(contrast(color, Colors.background)).toBeGreaterThanOrEqual(7);
    }
    for (const color of [Colors.textMuted, Colors.placeholder]) {
      expect(contrast(color, Colors.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(color, '#2E2E2E')).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(Colors.onAccent, Colors.accent)).toBeGreaterThanOrEqual(7);
    expect(contrast(Colors.onAccentSecondary, Colors.accentSecondary)).toBeGreaterThanOrEqual(7);
  });
});
