import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Platform, type KeyboardEvent, type View } from 'react-native';
import { Spacing } from '@/constants/theme';

export function keyboardOverlap(top: number, height: number, keyboardTop: number | null): number {
  if (keyboardTop == null) return 0;
  return Math.min(height, Math.max(0, top + height - keyboardTop));
}

export function fieldScrollOffset(inputTop: number, inputHeight: number, viewportTop: number, viewportHeight: number, offset: number): number {
  const margin = Math.min(Spacing.two, viewportHeight / 4);
  const below = inputTop + inputHeight - (viewportTop + viewportHeight - margin);
  if (below > 0) return Math.max(0, offset + below);
  const above = inputTop - viewportTop - margin;
  return above < 0 ? Math.max(0, offset + above) : offset;
}

/** Measure the obscured part, not raw keyboard height: adjustResize may already
 * have shortened the viewport, in which case applying height again is wrong. */
export function useKeyboardOverlap(active = true) {
  const view = useRef<View | null>(null);
  const frame = useRef<number | null>(null);
  const alive = useRef(false);
  const [inset, setInset] = useState(0);
  const [visible, setVisible] = useState(false);
  const measurement = useRef(0);

  const measure = useCallback(() => {
    const token = ++measurement.current;
    const keyboardTop = frame.current;
    view.current?.measureInWindow((_x, top, _width, height) => {
      if (!alive.current || token !== measurement.current) return;
      const next = keyboardOverlap(top, height, keyboardTop);
      setVisible(keyboardTop != null);
      setInset((previous) => Math.abs(previous - next) < 1 ? previous : next);
    });
  }, []);

  const attach = useCallback((node: View | null) => {
    view.current = node;
    if (node) measure();
  }, [measure]);

  useEffect(() => {
    alive.current = active;
    if (!active) return;
    const metrics = Keyboard.metrics();
    frame.current = metrics && metrics.height > 0 ? metrics.screenY : null;
    const apply = (event?: KeyboardEvent) => {
      frame.current = event && event.endCoordinates.height > 0 ? event.endCoordinates.screenY : null;
      measure();
    };
    const show = Keyboard.addListener('keyboardDidShow', apply);
    const hide = Keyboard.addListener('keyboardDidHide', () => apply());
    const change = Platform.OS === 'ios'
      ? Keyboard.addListener('keyboardWillChangeFrame', apply) : null;
    measure();
    return () => {
      alive.current = false;
      show.remove();
      hide.remove();
      change?.remove();
    };
  }, [active, measure]);

  return { ref: attach, inset, visible, measure };
}
