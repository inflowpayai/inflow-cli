import { useApp } from 'ink';
import { useCallback, useRef } from 'react';
import { runBestEffortCancel } from '../utils/best-effort-cancel.js';

/**
 * Centralizes the teardown every Ink command view performs: forward a final result to `onComplete`, then unmount the
 * app via `useApp().exit()`. Guards the cases that are easy to get subtly wrong: double-exit, exiting without
 * forwarding the result, and teardown blocking on a slow network call.
 *
 * Returns:
 *
 * - `finish(...args)` — run `onComplete(...args)` then `exit()`, at most once. Safe to wire into terminal-state effects
 *   that may re-fire.
 * - `cancelThenFinish(cancel, ...args)` — fire a best-effort `cancel` and `finish(...args)` as soon as the cancel settles
 *   or a short grace window elapses, whichever comes first (see {@link runBestEffortCancel}). Never lets a
 *   slow/unresponsive cancel request block teardown. Ignores repeat calls.
 *
 * The generic `A` mirrors the view's `onComplete` argument list, so `finish` is type-identical to the callback it wraps
 * (zero args, a single result, an outcome union, etc.).
 */
export function useFlowExit<A extends unknown[]>(
  onComplete: (...args: A) => void,
): {
  finish: (...args: A) => void;
  cancelThenFinish: (cancel: (() => Promise<unknown> | void) | undefined, ...args: A) => void;
} {
  const { exit } = useApp();
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const settledRef = useRef(false);
  const cancelStartedRef = useRef(false);

  const finish = useCallback(
    (...args: A) => {
      if (settledRef.current) return;
      settledRef.current = true;
      onCompleteRef.current(...args);
      exit();
    },
    [exit],
  );

  const cancelThenFinish = useCallback(
    (cancel: (() => Promise<unknown> | void) | undefined, ...args: A) => {
      if (cancelStartedRef.current || settledRef.current) return;
      cancelStartedRef.current = true;
      runBestEffortCancel(cancel, () => finish(...args));
    },
    [finish],
  );

  return { finish, cancelThenFinish };
}
