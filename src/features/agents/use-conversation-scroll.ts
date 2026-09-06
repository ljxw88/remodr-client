import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useReduceMotion } from '@/hooks/use-reduce-motion';

const BOTTOM_THRESHOLD = 48;
type Gesture = 'idle' | 'dragging' | 'released' | 'momentum';

type Props = {
  conversationId?: string;
  active: boolean;
  scrollToLatest: (animated: boolean) => void;
};

/** Inverted lists put the newest content at offset zero. Follow layout, not
 * just data: markdown, queued messages and the composer measure separately. */
export function useConversationScroll({ conversationId, active, scrollToLatest }: Props) {
  const [position, setPosition] = useState({ conversationId, following: true });
  if (position.conversationId !== conversationId) {
    setPosition({ conversationId, following: true });
  }
  const following = position.conversationId === conversationId ? position.following : true;
  const follow = useRef(true);
  const gesture = useRef<Gesture>('idle');
  const frame = useRef<number | null>(null);
  const animate = useRef(false);
  const enabled = useRef(active);
  const shouldReduceMotion = useReduceMotion();

  useLayoutEffect(() => {
    enabled.current = active;
  }, [active]);

  const cancel = useCallback(() => {
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = null;
    animate.current = false;
  }, []);

  const setFollow = useCallback((next: boolean) => {
    follow.current = next;
    setPosition((current) => current.following === next ? current : { ...current, following: next });
  }, []);

  const schedule = useCallback((animated = false) => {
    if (!enabled.current || !follow.current || gesture.current === 'dragging' || gesture.current === 'momentum') return;
    animate.current ||= animated;
    if (frame.current != null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const animated = animate.current && !shouldReduceMotion();
      animate.current = false;
      if (enabled.current && follow.current && gesture.current !== 'dragging' && gesture.current !== 'momentum') {
        scrollToLatest(animated);
      }
    });
  }, [scrollToLatest, shouldReduceMotion]);

  useLayoutEffect(() => {
    cancel();
    gesture.current = 'idle';
    follow.current = true;
  }, [conversationId, cancel]);

  useEffect(() => {
    if (active) schedule();
    else {
      gesture.current = 'idle';
    }
    return cancel;
  }, [active, conversationId, schedule, cancel]);

  const followLatest = useCallback(() => {
    cancel();
    gesture.current = 'idle';
    setFollow(true);
    schedule(true);
  }, [cancel, schedule, setFollow]);

  const onScroll = useCallback((offset: number) => {
    // Native anchoring and row growth also emit scroll events. Only a user
    // gesture may pause following; otherwise a long reply disables its own follow.
    if (gesture.current === 'dragging' || gesture.current === 'momentum') {
      setFollow(offset <= BOTTOM_THRESHOLD);
    }
  }, [setFollow]);

  const onScrollBeginDrag = useCallback((offset: number) => {
    cancel();
    gesture.current = 'dragging';
    setFollow(offset <= BOTTOM_THRESHOLD);
  }, [cancel, setFollow]);

  const onScrollEndDrag = useCallback((offset: number) => {
    if (gesture.current !== 'dragging') return;
    gesture.current = 'released';
    setFollow(offset <= BOTTOM_THRESHOLD);
  }, [setFollow]);

  const onMomentumScrollBegin = useCallback(() => {
    if (gesture.current !== 'dragging' && gesture.current !== 'released') return;
    cancel();
    gesture.current = 'momentum';
  }, [cancel]);

  const onMomentumScrollEnd = useCallback((offset: number) => {
    if (gesture.current !== 'momentum') return;
    gesture.current = 'idle';
    setFollow(offset <= BOTTOM_THRESHOLD);
    schedule();
  }, [schedule, setFollow]);

  return {
    following,
    followLatest,
    schedule,
    onScroll,
    onScrollBeginDrag,
    onScrollEndDrag,
    onMomentumScrollBegin,
    onMomentumScrollEnd,
  };
}
