import { useEffect, useState } from 'react';

const TICK_MS = 32;
/**
 * Ticks to reveal one burst, whatever its size — about 900ms.
 *
 * Deliberately just under the one-second poll that delivers the bursts. Reveal
 * faster and the text arrives in spurts with a pause between them, which is
 * the stutter this exists to remove; reveal slower and it falls further behind
 * with every burst.
 */
const TICKS_PER_BURST = 28;
/** Never crawl: a few characters still arrive at a readable pace. */
const MIN_CHARS_PER_TICK = 2;

/**
 * Characters per tick, fixed for the whole burst.
 *
 * Deliberately not recomputed from what is left on each tick. A rate
 * proportional to the remaining backlog decays geometrically, so the tail
 * crawls: a 20,000 character dump took nearly three seconds to finish, almost
 * all of it in the final few hundred characters.
 */
export function revealRate(backlog: number): number {
  return Math.max(MIN_CHARS_PER_TICK, Math.ceil(backlog / TICKS_PER_BURST));
}

type Reveal = {
  /** The text this burst is catching up to. */
  target: string;
  shown: number;
  rate: number;
};

/**
 * Reveals text as it grows, rather than in whatever chunks the transport
 * happens to deliver.
 *
 * The agent's output arrives as whole snapshots on a poll, so a reply lands in
 * one-second steps: a paragraph at once, then nothing, then another. This hands
 * the UI a prefix that catches up to the real text, which reads as the agent
 * writing rather than as the screen stuttering.
 *
 * With `enabled` false the text is shown outright, so opening a finished
 * conversation never types its history back out.
 */
export function useRevealedText(text: string, enabled: boolean): string {
  const [reveal, setReveal] = useState<Reveal>(() => ({
    target: text,
    shown: enabled ? 0 : text.length,
    rate: MIN_CHARS_PER_TICK,
  }));

  useEffect(() => {
    if (reveal.shown >= text.length) {
      return;
    }
    // Advanced from a timer, never straight from the effect body, so a render
    // never cascades into another one.
    const timer = setTimeout(
      () => {
        setReveal((current) => {
          if (!enabled || !text.startsWith(current.target)) {
            // Finished, or rewritten rather than appended to: show it all.
            return { target: text, shown: text.length, rate: current.rate };
          }
          const rate =
            current.target === text
              ? current.rate
              : revealRate(text.length - current.shown);
          return {
            target: text,
            shown: Math.min(text.length, current.shown + rate),
            rate,
          };
        });
      },
      enabled ? TICK_MS : 0,
    );
    return () => clearTimeout(timer);
    // `reveal` itself is the dependency, not just whether it has caught up:
    // each tick has to re-run this to schedule the next one. Depending on a
    // derived boolean instead stalled the reveal after a single step.
  }, [enabled, reveal, text]);

  return text.slice(0, reveal.shown);
}
