import { createElement } from 'react';
import TestRenderer from 'react-test-renderer';

import { useConversationScroll } from './use-conversation-scroll';

let mockReducedMotion = false;
const mockShouldReduceMotion = () => mockReducedMotion;
jest.mock('@/hooks/use-reduce-motion', () => ({
  useReduceMotion: () => mockShouldReduceMotion,
}));

describe('inverted conversation following', () => {
  let controller: ReturnType<typeof useConversationScroll>;
  let renderer: TestRenderer.ReactTestRenderer;
  const scrollToLatest = jest.fn();

  function Harness({ id = 'agent-a', active = true }: { id?: string; active?: boolean }) {
    controller = useConversationScroll({ conversationId: id, active, scrollToLatest });
    return null;
  }

  function flush() {
    TestRenderer.act(() => jest.advanceTimersByTime(20));
  }

  function readHistory() {
    TestRenderer.act(() => {
      controller.onScrollBeginDrag(0);
      controller.onScroll(240);
      controller.onScrollEndDrag(240);
    });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    scrollToLatest.mockClear();
    mockReducedMotion = false;
    TestRenderer.act(() => { renderer = TestRenderer.create(createElement(Harness)); });
    flush();
    scrollToLatest.mockClear();
  });

  afterEach(() => {
    TestRenderer.act(() => renderer.unmount());
    jest.useRealTimers();
  });

  it('follows late measurements and streaming growth even when native layout changes the offset', () => {
    TestRenderer.act(() => {
      controller.onScroll(600);
      controller.schedule();
      controller.schedule();
      controller.schedule();
    });
    expect(controller.following).toBe(true);
    expect(scrollToLatest).not.toHaveBeenCalled();
    flush();
    expect(scrollToLatest.mock.calls).toEqual([[false]]);
    TestRenderer.act(() => controller.schedule());
    flush();
    expect(scrollToLatest.mock.calls).toEqual([[false], [false]]);
  });

  it('does not pull the reader away from history during new messages or momentum', () => {
    readHistory();
    TestRenderer.act(() => {
      controller.onMomentumScrollBegin();
      controller.onScroll(500);
      controller.schedule();
      controller.onMomentumScrollEnd(500);
      controller.schedule();
    });
    flush();
    expect(controller.following).toBe(false);
    expect(scrollToLatest).not.toHaveBeenCalled();
  });

  it('resumes immediately for Send or Latest and stays pinned through subsequent layouts', () => {
    readHistory();
    TestRenderer.act(() => {
      controller.followLatest();
      controller.onScroll(500);
      controller.onMomentumScrollBegin();
      controller.onMomentumScrollEnd(500);
    });
    flush();
    expect(controller.following).toBe(true);
    expect(scrollToLatest).toHaveBeenLastCalledWith(true);
    TestRenderer.act(() => controller.schedule());
    flush();
    expect(scrollToLatest).toHaveBeenLastCalledWith(false);
  });

  it('lets a new user gesture cancel a pending automatic follow', () => {
    TestRenderer.act(() => {
      controller.schedule();
      controller.onScrollBeginDrag(0);
      controller.onScroll(100);
      controller.onScrollEndDrag(100);
    });
    flush();
    expect(controller.following).toBe(false);
    expect(scrollToLatest).not.toHaveBeenCalled();
  });

  it('resumes following after the reader scrolls back near the bottom', () => {
    readHistory();
    TestRenderer.act(() => {
      controller.onScrollBeginDrag(240);
      controller.onScrollEndDrag(80);
      controller.onMomentumScrollBegin();
      controller.onScroll(20);
      controller.onMomentumScrollEnd(20);
    });
    flush();
    expect(controller.following).toBe(true);
    expect(scrollToLatest).toHaveBeenCalledWith(false);
  });

  it('preserves history on refocus but resets following for a different conversation', () => {
    readHistory();
    TestRenderer.act(() => renderer.update(createElement(Harness, { active: false })));
    TestRenderer.act(() => renderer.update(createElement(Harness)));
    flush();
    expect(scrollToLatest).not.toHaveBeenCalled();
    expect(controller.following).toBe(false);
    TestRenderer.act(() => renderer.update(createElement(Harness, { id: 'agent-b' })));
    flush();
    expect(controller.following).toBe(true);
    expect(scrollToLatest).toHaveBeenCalledWith(false);
  });

  it('cancels work while hidden and clears an interrupted gesture on resume', () => {
    TestRenderer.act(() => {
      controller.schedule();
      controller.onScrollBeginDrag(0);
    });
    TestRenderer.act(() => renderer.update(createElement(Harness, { active: false })));
    flush();
    expect(scrollToLatest).not.toHaveBeenCalled();
    TestRenderer.act(() => renderer.update(createElement(Harness)));
    flush();
    expect(scrollToLatest).toHaveBeenCalledWith(false);
  });

  it('respects reduced motion for explicit jumps', () => {
    mockReducedMotion = true;
    TestRenderer.act(() => controller.followLatest());
    flush();
    expect(scrollToLatest).toHaveBeenCalledWith(false);
  });

  it('cleans up scheduled scrolls when unmounted', () => {
    TestRenderer.act(() => {
      controller.schedule();
      renderer.unmount();
    });
    flush();
    expect(scrollToLatest).not.toHaveBeenCalled();
  });
});
