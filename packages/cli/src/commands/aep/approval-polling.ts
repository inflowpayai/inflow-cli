import type { Inflow } from '@inflowpayai/inflow-core';

export { cancelApproval } from '../approval-cancellation.js';

export class ApprovalCancelledError extends Error {}
export class ApprovalTimeoutError extends Error {}

export async function approvalStatus(inflow: Inflow, approvalId: string, signal?: AbortSignal): Promise<string> {
  const headers = await withAbortSignal(inflow.platformAuthenticationHeaders(), signal);
  const response = await fetch(new URL(`/v1/approvals/${approvalId}`, inflow.resolvedApiBaseUrl), {
    headers,
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) throw new Error('Approval status request failed.');
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || typeof (body as Record<string, unknown>)['status'] !== 'string') {
    throw new Error('Approval status response is invalid.');
  }
  return (body as Record<string, string>)['status'] as string;
}

export async function approvalStatusBeforeDeadline(
  inflow: Inflow,
  approvalId: string,
  deadline: number,
  cancellationSignals: readonly (AbortSignal | undefined)[],
): Promise<string> {
  if (cancellationSignals.some((signal) => signal?.aborted === true)) throw new ApprovalCancelledError();
  const remainingMilliseconds = deadline - Date.now();
  if (remainingMilliseconds <= 0) throw new ApprovalTimeoutError();
  const deadlineSignal = AbortSignal.timeout(remainingMilliseconds);
  const signals = cancellationSignals.filter((signal): signal is AbortSignal => signal !== undefined);
  try {
    return await approvalStatus(inflow, approvalId, AbortSignal.any([deadlineSignal, ...signals]));
  } catch (cause) {
    if (signals.some((signal) => signal.aborted)) throw new ApprovalCancelledError();
    if (deadlineSignal.aborted) throw new ApprovalTimeoutError();
    throw cause;
  }
}

export async function approvalSleep(
  milliseconds: number,
  signals: readonly (AbortSignal | undefined)[],
): Promise<void> {
  if (signals.some((signal) => signal?.aborted === true)) throw new ApprovalCancelledError();
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      for (const signal of signals) signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      clearTimeout(timeout);
      cleanup();
      reject(new ApprovalCancelledError());
    };
    const timeout: ReturnType<typeof setTimeout> = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    for (const signal of signals) signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function remainingApprovalDelay(deadline: number, intervalMilliseconds: number): number {
  return Math.max(0, Math.min(intervalMilliseconds, deadline - Date.now()));
}

async function withAbortSignal<T>(operation: T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (cause: unknown) => {
        cleanup();
        reject(cause instanceof Error ? cause : new Error('Approval authentication failed.', { cause }));
      },
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Approval request aborted.', { cause: signal.reason });
}
