import type { MppSupportedResponse } from '@inflowpayai/mpp';
import { describe, expect, it, vi } from 'vitest';
import type { IMppResource } from '../../../src/client.js';
import { runMppSupported } from '../../../src/flows/mpp-supported.js';

describe('runMppSupported', () => {
  it('returns the buyer-supported kinds from the client', async () => {
    const supported: MppSupportedResponse = {
      kinds: [
        {
          method: 'inflow',
          intents: [
            {
              intent: 'charge',
              rails: [
                { rail: 'balance', currencies: ['USDC', 'USDT'] },
                { rail: 'instrument', currencies: ['USD'] },
              ],
            },
          ],
        },
      ],
    };
    const mpp: IMppResource = {
      client: vi.fn().mockResolvedValue({ getSupported: vi.fn().mockResolvedValue(supported) }),
      cancelApproval: vi.fn(),
    };
    const out = await runMppSupported({ mpp });
    expect(out).toEqual(supported);
  });
});
