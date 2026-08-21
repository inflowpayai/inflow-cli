import { useApp } from 'ink';
import { useCallback, useRef } from 'react';

/**
 * Centralizes the teardown every Ink command view performs: forward a final result to `onComplete`, then unmount the
 * app via `useApp().exit()`. Guards against double-exit and exiting without forwarding the result.
 *
 * Returns:
 *
 * - `finish(...args)` — run `onComplete(...args)` then `exit()`, at most once. Safe to wire into terminal-state effects
 *   that may re-fire. The generic `A` mirrors the view's `onComplete` argument list, so `finish` is type-identical to
 *   the callback it wraps (zero args, a single result, an outcome union, etc.).
 */
export function useFlowExit<A extends unknown[]>(
  onComplete: (...args: A) => void,
): {
  finish: (...args: A) => void;
} {
  const { exit } = useApp();
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const settledRef = useRef(false);

  const finish = useCallback(
    (...args: A) => {
      if (settledRef.current) return;
      settledRef.current = true;
      onCompleteRef.current(...args);
      exit();
    },
    [exit],
  );

  return { finish };
}
