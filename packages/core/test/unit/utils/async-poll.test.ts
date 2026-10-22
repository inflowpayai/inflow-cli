import { afterEach, describe, expect, it, vi } from 'vitest';
import { pollAsync } from '../../../src/utils/async-poll.js';

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of gen) {
    out.push(value);
  }
  return out;
}

describe('pollAsync', () => {
  afterEach(() => vi.useRealTimers());

  it('disables the deadline for negative timeout while still enforcing the attempt limit', async () => {
    vi.useFakeTimers();
    const fn = vi.fn(() => Promise.resolve('pending'));
    const result = drain(pollAsync({ fn, isTerminal: () => false, interval: 60, maxAttempts: 3, timeout: -1 }));
    await vi.runAllTimersAsync();
    expect(await result).toEqual([
      { value: 'pending', terminal: false },
      { value: 'pending', terminal: false },
      { value: 'pending', terminal: true, reason: 'max_attempts' },
    ]);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a terminal response even when the timeout is zero', async () => {
    const fn = vi.fn(() => Promise.resolve('ready'));
    expect(await drain(pollAsync({ fn, isTerminal: () => true, interval: 5, maxAttempts: 0, timeout: 0 }))).toEqual([
      { value: 'ready', terminal: true },
    ]);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('cancels a sleeping poll without making another request or leaving a timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fn = vi.fn(() => Promise.resolve('pending'));
    const poll = pollAsync({
      fn,
      isTerminal: () => false,
      interval: 60,
      maxAttempts: 0,
      timeout: -1,
      signal: controller.signal,
    });
    expect(await poll.next()).toMatchObject({ value: { value: 'pending', terminal: false } });
    const pending = poll.next();
    const rejection = expect(pending).rejects.toThrow('Poll aborted.');
    controller.abort();
    await rejection;
    await vi.runAllTimersAsync();
    expect(fn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect((await poll.next()).done).toBe(true);
  });

  it('stops immediately when isTerminal returns true on the first call', async () => {
    let calls = 0;
    const results = await drain(
      pollAsync<{ done: boolean }>({
        fn: () => {
          calls++;
          return Promise.resolve({ done: true });
        },
        isTerminal: (v) => v.done,
        interval: 1,
        maxAttempts: 10,
        timeout: 60,
      }),
    );

    expect(calls).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ value: { done: true }, terminal: true });
  });

  it('yields only on snapshot change before terminating', async () => {
    const values = [{ state: 'a' }, { state: 'a' }, { state: 'b' }, { state: 'done' }];
    let i = 0;
    const results = await drain(
      pollAsync<{ state: string }>({
        fn: () => Promise.resolve(values[i++] ?? { state: 'done' }),
        isTerminal: (v) => v.state === 'done',
        isEqual: (prev, next) => prev.state === next.state,
        interval: 0.01,
        maxAttempts: 100,
        timeout: 60,
      }),
    );

    expect(results.map((r) => r.value.state)).toEqual(['a', 'b', 'done']);
    expect(results[results.length - 1]?.terminal).toBe(true);
  });

  it('reports max_attempts when the cap is reached', async () => {
    let calls = 0;
    const results = await drain(
      pollAsync<number>({
        fn: () => Promise.resolve(++calls),
        isTerminal: () => false,
        interval: 0.005,
        maxAttempts: 3,
        timeout: 60,
      }),
    );

    const last = results[results.length - 1];
    expect(last?.terminal).toBe(true);
    expect(last?.reason).toBe('max_attempts');
    expect(calls).toBe(3);
  });

  it('reports timeout when the deadline is exceeded', async () => {
    let calls = 0;
    const results = await drain(
      pollAsync<number>({
        fn: () => Promise.resolve(++calls),
        isTerminal: () => false,
        interval: 0.05,
        maxAttempts: 0,
        timeout: 0,
      }),
    );

    const last = results[results.length - 1];
    expect(last?.terminal).toBe(true);
    expect(last?.reason).toBe('timeout');
    expect(calls).toBe(1);
  });

  it('runs once when interval is <= 0', async () => {
    let calls = 0;
    const results = await drain(
      pollAsync<number>({
        fn: () => Promise.resolve(++calls),
        isTerminal: () => false,
        interval: 0,
        maxAttempts: 99,
        timeout: 99,
      }),
    );

    expect(calls).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]?.terminal).toBe(true);
  });
});
