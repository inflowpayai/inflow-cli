/** How long to let a best-effort approval cancel run before exiting regardless. */
export const CANCEL_GRACE_MS = 1500;

/**
 * Fire a best-effort approval cancel, then run `done` — but never let the cancel request block `done`.
 *
 * Both the x402 and mpp buyer `cancelApproval` calls `await` a `POST .../cancel` bounded by the SDK's default 30s
 * request timeout. Gating teardown on that promise lets an unresponsive cancel endpoint stall the Ink app for up to 30s
 * (perceived as a hang). The cancel races a `graceMs` timer instead: whichever settles first runs `done` exactly once,
 * so the Escape-to-cancel handler tears down promptly while the cancel still gets a brief window to reach the server.
 */
export function runBestEffortCancel(
  cancel: (() => Promise<unknown> | void) | undefined,
  done: () => void,
  graceMs: number = CANCEL_GRACE_MS,
): void {
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    done();
  };
  // Not `unref`'d on purpose: the grace timer is the guarantee that `done` (which tears down the app) runs even if the
  // cancel request never settles. It fires at most `graceMs` later, then teardown proceeds, so it cannot strand the
  // process.
  const timer = setTimeout(finish, graceMs);
  void Promise.resolve(cancel?.())
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(timer);
      finish();
    });
}
