import type { IMppResource } from '../client.js';

export interface MppCancelInput {
  mpp: IMppResource;
  approvalId: string;
}

export interface MppCancelResult {
  approval_id: string;
  cancelled: true;
  note: string;
}

/**
 * Best-effort cancel of an in-flight MPP approval. Delegates to `@inflowpayai/mpp-buyer`'s `cancelApproval` (which
 * fire-and-forgets `POST /v1/approvals/{id}/cancel`) rather than re-issuing the call here. Like `x402 cancel`, this
 * does not poll for confirmation — hence the `note` calling out that server-side state is not verified.
 */
export async function runMppCancel(input: MppCancelInput): Promise<MppCancelResult> {
  await input.mpp.cancelApproval(input.approvalId);
  return {
    approval_id: input.approvalId,
    cancelled: true,
    note: 'best-effort; server-side state not verified',
  };
}
