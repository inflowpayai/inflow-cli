import type { Inflow } from '@inflowpayai/inflow-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalCancellationRequestError, cancelApproval } from '../../../src/commands/approval-cancellation.js';

function inflow(platformAuthenticationHeaders: () => Promise<Record<string, string>>): Inflow {
  return {
    platformAuthenticationHeaders,
    resolvedApiBaseUrl: 'https://api.inflowpay.ai',
  } as Inflow;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('cancelApproval', () => {
  it('rejects a failed cancellation response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
    );

    await expect(
      cancelApproval(
        inflow(() => Promise.resolve({ Authorization: 'Bearer token' })),
        'approval-1',
      ),
    ).rejects.toBeInstanceOf(ApprovalCancellationRequestError);
  });

  it('stops waiting for authentication when the cancellation deadline expires', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const cancellation = cancelApproval(
      inflow(() => new Promise(() => undefined)),
      'approval-1',
    );
    const reason = new Error('deadline');

    controller.abort(reason);

    await expect(cancellation).rejects.toBe(reason);
  });

  it('normalizes non-error authentication failures', async () => {
    const platformAuthenticationHeaders = vi.fn<() => Promise<Record<string, string>>>().mockRejectedValue('offline');
    await expect(cancelApproval(inflow(platformAuthenticationHeaders), 'approval-1')).rejects.toThrow(
      'Approval authentication failed.',
    );
  });

  it('normalizes a non-error abort reason', async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const cancellation = cancelApproval(
      inflow(() => new Promise(() => undefined)),
      'approval-1',
    );

    controller.abort('deadline');

    await expect(cancellation).rejects.toThrow('Approval request aborted.');
  });
});
