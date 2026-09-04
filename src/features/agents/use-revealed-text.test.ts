import { revealRate } from '@/features/agents/use-revealed-text';

/**
 * The reveal rate is the part worth pinning down: it has to converge on any
 * burst size rather than falling behind a fast one.
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
