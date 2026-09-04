import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';

import { revealRate, useRevealedText } from '@/features/agents/use-revealed-text';

/**
 * The reveal rate has to converge on any burst size rather than falling behind
 * a fast one, and take about the same time whatever the size.
 */
function stepsToReveal(length: number): number {
  const rate = revealRate(length);
  let shown = 0;
  let steps = 0;
  while (shown < length) {
    shown += rate;
    steps += 1;
    if (steps > 10_000) {
      throw new Error('reveal did not converge');
    }
  }
  return steps;
}

describe('reveal rate', () => {
  it('converges for a short burst', () => {
    expect(stepsToReveal(20)).toBeLessThanOrEqual(28);
  });

  it('stays under the poll interval that delivers the next burst', () => {
    // 28 ticks x 32ms is about 900ms, just inside the one-second poll.
    expect(stepsToReveal(20_000) * 32).toBeLessThan(1_000);
  });

  it('takes the same time for a long burst as a short one', () => {
    // The rate scales with the burst, so size does not change the duration.
    // A backlog-proportional rate decayed instead, and 20k characters took
    // nearly three seconds, almost all of it in the final few hundred.
    expect(stepsToReveal(20_000)).toBeLessThanOrEqual(28);
    expect(stepsToReveal(600)).toBeLessThanOrEqual(28);
  });

  it('always advances, so it can never stall', () => {
    for (const length of [1, 2, 3, 7, 100, 5_000]) {
      expect(stepsToReveal(length)).toBeGreaterThan(0);
    }
  });
});

/** Drives the hook so its output can be read after each batch of timers. */
function mount(text: string, enabled: boolean) {
  let latest = '';
  function Probe({ value, on }: { value: string; on: boolean }) {
    latest = useRevealedText(value, on);
    return null;
  }
  let renderer!: TestRenderer.ReactTestRenderer;
  TestRenderer.act(() => {
    renderer = TestRenderer.create(createElement(Probe, { value: text, on: enabled }));
  });
  return {
    get revealed() {
      return latest;
    },
    update(nextText: string, nextEnabled: boolean) {
      TestRenderer.act(() => {
        renderer.update(createElement(Probe, { value: nextText, on: nextEnabled }));
      });
    },
    /**
     * Advances one tick at a time. Each tick's timer is scheduled by the
     * effect that runs after the previous tick's state update commits, so a
     * single large jump only ever fires the first of them.
     */
    advance(ms: number) {
      for (let elapsed = 0; elapsed < ms; elapsed += 32) {
        TestRenderer.act(() => {
          jest.advanceTimersByTime(32);
        });
      }
    },
    unmount() {
      TestRenderer.act(() => renderer.unmount());
    },
  };
}

describe('useRevealedText', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('shows finished text outright, so history never types itself out', () => {
    const probe = mount('a settled reply', false);
    expect(probe.revealed).toBe('a settled reply');
    probe.unmount();
  });

  it('reveals progressively while the agent is still writing', () => {
    const probe = mount('', true);
    probe.update('the quick brown fox jumps over the lazy dog', true);

    probe.advance(32);
    const first = probe.revealed;
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan('the quick brown fox jumps over the lazy dog'.length);

    probe.advance(32);
    expect(probe.revealed.length).toBeGreaterThan(first.length);
    probe.unmount();
  });

  it('always reveals a prefix of the real text, never scrambled output', () => {
    const target = 'streaming text arrives in whole snapshots';
    const probe = mount('', true);
    probe.update(target, true);
    for (let tick = 0; tick < 5; tick += 1) {
      probe.advance(32);
      expect(target.startsWith(probe.revealed)).toBe(true);
    }
    probe.unmount();
  });

  it('catches up within its budget', () => {
    const target = 'x'.repeat(4_000);
    const probe = mount('', true);
    probe.update(target, true);
    probe.advance(1_000);
    expect(probe.revealed).toBe(target);
    probe.unmount();
  });

  it('keeps up when more text arrives mid-reveal', () => {
    const probe = mount('', true);
    probe.update('first burst. ', true);
    probe.advance(64);
    probe.update('first burst. second burst arrives before the first finished.', true);
    probe.advance(1_000);
    expect(probe.revealed).toBe(
      'first burst. second burst arrives before the first finished.',
    );
    probe.unmount();
  });

  it('jumps to the full text the moment the agent stops', () => {
    const target = 'a reply that was still being revealed when it finished';
    const probe = mount('', true);
    probe.update(target, true);
    probe.advance(32);
    expect(probe.revealed).not.toBe(target);

    probe.update(target, false);
    probe.advance(1);
    expect(probe.revealed).toBe(target);
    probe.unmount();
  });

  it('shows a rewritten message in full rather than a stale prefix', () => {
    const probe = mount('', true);
    probe.update('aaaaaaaaaaaaaaaaaaaa', true);
    probe.advance(32);
    probe.update('completely different text', true);
    probe.advance(32);
    expect(probe.revealed).toBe('completely different text');
    probe.unmount();
  });
});
