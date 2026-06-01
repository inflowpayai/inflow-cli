import { describe, expect, it, vi } from 'vitest';
import type { IMppResource } from '../../../src/client.js';
import { runMppCancel } from '../../../src/flows/mpp-cancel.js';

describe('runMppCancel', () => {
  it('delegates to the resource cancelApproval and returns the best-effort envelope', async () => {
    const cancelApproval = vi.fn().mockResolvedValue(undefined);
    const mpp: IMppResource = { client: vi.fn(), cancelApproval };
    const out = await runMppCancel({ mpp, approvalId: 'ap-7' });
    expect(cancelApproval).toHaveBeenCalledWith('ap-7');
    expect(out).toEqual({
      approval_id: 'ap-7',
      cancelled: true,
      note: 'best-effort; server-side state not verified',
    });
  });
});
