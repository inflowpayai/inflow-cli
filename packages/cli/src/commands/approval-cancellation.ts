import type { Inflow } from '@inflowpayai/inflow-core';

const APPROVAL_CANCEL_TIMEOUT_MILLISECONDS = 5_000;

export class ApprovalCancellationRequestError extends Error {}

export async function cancelApproval(inflow: Inflow, approvalId: string): Promise<void> {
  const signal = AbortSignal.timeout(APPROVAL_CANCEL_TIMEOUT_MILLISECONDS);
  const headers = await withAbortSignal(inflow.platformAuthenticationHeaders(), signal);
  const response = await fetch(new URL(`/v1/approvals/${approvalId}/cancel`, inflow.resolvedApiBaseUrl), {
    headers,
    method: 'POST',
    signal,
  });
  if (!response.ok) throw new ApprovalCancellationRequestError('Approval cancellation request failed.');
}

async function withAbortSignal<T>(operation: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
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
