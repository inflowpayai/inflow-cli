import type { MppSupportedResponse } from '@inflowpayai/mpp';
import type { IMppResource } from '../client.js';

export interface MppSupportedInput {
  mpp: IMppResource;
}

/**
 * Return the methods the authenticated buyer can pay with (`GET /v1/transactions/mpp-supported`) — broken down by
 * intent and settlement rail with the currencies available on each rail. The buyer analog of x402's `getSupported`.
 * Triggers the lazy construction of the underlying {@link IMppResource} client if it hasn't been built yet.
 */
export async function runMppSupported(input: MppSupportedInput): Promise<MppSupportedResponse> {
  const client = await input.mpp.client();
  return client.getSupported();
}
