import { createElement, useEffect } from 'react';
import TestRenderer from 'react-test-renderer';
import { Keyboard, type View, type KeyboardEvent } from 'react-native';

import { fieldScrollOffset, keyboardOverlap, useKeyboardOverlap } from './use-keyboard-overlap';

describe('keyboard viewport geometry', () => {
  it('reveals fields against the real scroll viewport, including header and footer offsets', () => {
    expect(fieldScrollOffset(400, 44, 100, 320, 0)).toBe(40);
    expect(fieldScrollOffset(200, 44, 100, 320, 80)).toBe(80);
    expect(fieldScrollOffset(90, 44, 100, 320, 80)).toBe(54);
  });
  it('does not count a keyboard already handled by native adjustResize twice', () => {
    expect(keyboardOverlap(100, 400, 500)).toBe(0);
  });
  it('handles edge-to-edge viewports and native header offsets', () => {
    expect(keyboardOverlap(100, 700, 500)).toBe(300);
    expect(keyboardOverlap(160, 640, 500)).toBe(300);
  });
  it('clamps floating/hardware/hidden keyboard cases to the actual viewport', () => {
    expect(keyboardOverlap(100, 700, null)).toBe(0);
    expect(keyboardOverlap(100, 700, 900)).toBe(0);
    expect(keyboardOverlap(100, 700, 0)).toBe(700);
  });
});

describe('keyboard overlap lifecycle', () => {
  let renderer: TestRenderer.ReactTestRenderer;
  const events = new Map<string, (event: KeyboardEvent) => void>();
  const remove = jest.fn();
  const frame = (screenY: number, height: number) => ({
    duration: 250, easing: 'keyboard', endCoordinates: { screenX: 0, screenY, width: 400, height },
  } as KeyboardEvent);
  let latest: ReturnType<typeof useKeyboardOverlap>;
  let viewHeight = 700;
  const node = {
    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) =>
      callback(0, 100, 400, viewHeight),
  };
  function Probe({ active = true }) {
    latest = useKeyboardOverlap(active);
    useEffect(() => {
      latest.ref(node as unknown as View);
    }, []);
    return null;
  }

  beforeEach(() => {
    viewHeight = 700;
    events.clear();
    remove.mockClear();
    jest.spyOn(Keyboard, 'metrics').mockReturnValue(undefined);
    jest.spyOn(Keyboard, 'addListener').mockImplementation((name, listener) => {
      events.set(name, listener);
      return { remove };
    });
  });
  afterEach(() => {
    TestRenderer.act(() => renderer?.unmount());
    jest.restoreAllMocks();
  });

  it('follows show, resize and hide without an extra keyboard-height offset', () => {
    TestRenderer.act(() => { renderer = TestRenderer.create(createElement(Probe)); });
    TestRenderer.act(() => events.get('keyboardDidShow')!(frame(500, 300)));
    expect(latest.inset).toBe(300);
    expect(latest.visible).toBe(true);
    viewHeight = 400;
    TestRenderer.act(() => latest.measure());
    expect(latest.inset).toBe(0);
    expect(latest.visible).toBe(true);
    TestRenderer.act(() => events.get('keyboardDidHide')!(frame(800, 0)));
    expect(latest.visible).toBe(false);
    expect(latest.inset).toBe(0);
  });

  it('recognizes an already-open keyboard on a newly focused form', () => {
    jest.mocked(Keyboard.metrics).mockReturnValue(frame(500, 300).endCoordinates);
    TestRenderer.act(() => { renderer = TestRenderer.create(createElement(Probe)); });
    expect(latest.visible).toBe(true);
    expect(latest.inset).toBe(300);
  });

  it('unsubscribes when the page loses focus', () => {
    TestRenderer.act(() => { renderer = TestRenderer.create(createElement(Probe)); });
    TestRenderer.act(() => renderer.update(createElement(Probe, { active: false })));
    expect(remove).toHaveBeenCalled();
  });
});
