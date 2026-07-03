export type PollExitReason = 'max_attempts' | 'timeout';

export interface PollOptions<T> {
  fn: () => Promise<T>;
  isTerminal: (value: T) => boolean;
  interval: number;
  maxAttempts: number;
  timeout: number;
  /**
   * Optional equality check between the previous yielded value and the next tick's value. When provided and returns
   * `true`, the next tick is suppressed (no `terminal: false` yield). Use a cheap field-based comparison to dedup polls
   * where the same snapshot recurs across ticks; omit for callers that want every tick yielded.
   */
  isEqual?: (prev: T, next: T) => boolean;
  /**
   * Optional signal to abort the in-flight sleep between ticks. When fired, the generator throws an `Error('aborted')`
   * on the current sleep so callers can unwind cleanly without waiting for the next interval boundary.
   */
  signal?: AbortSignal;
}

export interface PollOutcome<T> {
  value: T;
  terminal: boolean;
  reason?: PollExitReason;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Poll aborted.'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(handle);
      reject(new Error('Poll aborted.'));
    };
    const handle = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function* pollAsync<T>(options: PollOptions<T>): AsyncGenerator<PollOutcome<T>> {
  const { fn, isTerminal, interval, maxAttempts, timeout, isEqual, signal } = options;
  const deadline = timeout >= 0 ? Date.now() + timeout * 1000 : undefined;
  const runOnce = interval <= 0;

  let attempts = 0;
  let lastYielded: { value: T } | undefined;

  for (;;) {
    const value = await fn();

    if (runOnce || isTerminal(value)) {
      yield { value, terminal: true };
      return;
    }

    attempts += 1;

    if (maxAttempts > 0 && attempts >= maxAttempts) {
      yield { value, terminal: true, reason: 'max_attempts' };
      return;
    }
    if (deadline !== undefined && Date.now() >= deadline) {
      yield { value, terminal: true, reason: 'timeout' };
      return;
    }

    const shouldYield = lastYielded === undefined || isEqual === undefined || !isEqual(lastYielded.value, value);
    if (shouldYield) {
      lastYielded = { value };
      yield { value, terminal: false };
    }

    await sleep(interval * 1000, signal);
  }
}
