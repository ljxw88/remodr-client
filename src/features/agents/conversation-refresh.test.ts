import { conversationRefreshInterval, startConversationRefresh } from './conversation-refresh';

describe('conversation refresh cadence', () => {
  it('continues reconciling idle and done sessions after their status event', () => {
    expect(conversationRefreshInterval('done', false, true)).toBe(3000);
    expect(conversationRefreshInterval('idle', false, true)).toBe(3000);
  });

  it('uses a bounded faster cadence while working or discovering a question', () => {
    expect(conversationRefreshInterval('working', false, true)).toBe(1000);
    expect(conversationRefreshInterval('working', false, false)).toBe(2000);
    expect(conversationRefreshInterval('blocked', false, true)).toBe(1000);
    expect(conversationRefreshInterval('blocked', true, true)).toBe(3000);
  });
});

describe('conversation refresh lifecycle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function setup(refresh = jest.fn<Promise<unknown>, []>().mockResolvedValue(undefined)) {
    return {
      interval: 3000, inFlight: { current: null as Promise<void> | null },
      refresh, onSuccess: jest.fn(), onError: jest.fn(),
    };
  }

  it('fetches a final reply written after the done-status snapshot', async () => {
    let transcript = '';
    let rendered = '';
    const options = setup(jest.fn(async () => { rendered = transcript; }));
    const stop = startConversationRefresh(options);
    await jest.advanceTimersByTimeAsync(0);
    expect(rendered).toBe('');
    transcript = 'The final response arrived after the status changed.';
    await jest.advanceTimersByTimeAsync(3000);
    expect(rendered).toBe(transcript);
    expect(options.refresh).toHaveBeenCalledTimes(2);
    stop();
  });

  it('never overlaps slow requests or lets a restarted effect overlap them', async () => {
    let finish!: () => void;
    const options = setup(jest.fn().mockImplementationOnce(
      () => new Promise<void>((resolve) => { finish = resolve; }),
    ).mockResolvedValue(undefined));
    const stopFirst = startConversationRefresh(options);
    await jest.advanceTimersByTimeAsync(30_000);
    expect(options.refresh).toHaveBeenCalledTimes(1);
    stopFirst();
    const stopSecond = startConversationRefresh({ ...options, interval: 1000 });
    await jest.advanceTimersByTimeAsync(5000);
    expect(options.refresh).toHaveBeenCalledTimes(1);
    finish();
    await jest.advanceTimersByTimeAsync(0);
    expect(options.refresh).toHaveBeenCalledTimes(2);
    expect(options.onSuccess).toHaveBeenCalledTimes(1);
    stopSecond();
  });

  it('stops scheduling and suppresses stale callbacks after unmount/disconnect', async () => {
    let finish!: () => void;
    const options = setup(jest.fn(() => new Promise<void>((resolve) => { finish = resolve; })));
    const stop = startConversationRefresh(options);
    await jest.advanceTimersByTimeAsync(0);
    stop();
    finish();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(options.refresh).toHaveBeenCalledTimes(1);
    expect(options.onSuccess).not.toHaveBeenCalled();
    expect(options.inFlight.current).toBeNull();
  });

  it('surfaces a failed read and continues without replaying or inventing text', async () => {
    const error = new Error('read failed');
    const options = setup(jest.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined));
    const stop = startConversationRefresh(options);
    await jest.advanceTimersByTimeAsync(0);
    expect(options.onError).toHaveBeenCalledWith(error);
    await jest.advanceTimersByTimeAsync(3000);
    expect(options.onSuccess).toHaveBeenCalledTimes(1);
    stop();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(options.refresh).toHaveBeenCalledTimes(2);
  });
});
