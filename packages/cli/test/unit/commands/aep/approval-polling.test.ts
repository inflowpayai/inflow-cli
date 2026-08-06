import { Inflow } from '@inflowpayai/inflow-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApprovalCancelledError,
  approvalSleep,
  approvalStatus,
  approvalStatusBeforeDeadline,
  ApprovalTimeoutError,
  cancelApproval,
  remainingApprovalDelay,
} from '../../../../src/commands/aep/approval-polling.js';

function inflow(): Inflow {
  const client = new Inflow({ apiBaseUrl: 'https://platform.example', apiKey: 'key' });
  vi.spyOn(client, 'platformAuthenticationHeaders').mockResolvedValue({ Authorization: 'Bearer test' });
  return client;
}

function stalledFetch(): typeof fetch {
  return vi.fn((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    return new Promise<Response>((_resolve, reject) => {
      if (init?.signal?.aborted === true) {
        reject(new Error('request aborted'));
        return;
      }
      init?.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
    });
  });
}

describe('AEP approval polling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('forwards caller cancellation to approval status requests', async () => {
    const signal = new AbortController().signal;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ status: 'APPROVED' }));

    await expect(approvalStatus(inflow(), 'approval-1', signal)).resolves.toBe('APPROVED');

    expect(fetchSpy).toHaveBeenCalledWith(new URL('/v1/approvals/approval-1', 'https://platform.example'), {
      headers: { Authorization: 'Bearer test' },
      signal,
    });
  });

  it('aborts an in-flight status request at the approval deadline', async () => {
    vi.stubGlobal('fetch', stalledFetch());

    await expect(approvalStatusBeforeDeadline(inflow(), 'approval-1', Date.now() + 5, [])).rejects.toBeInstanceOf(
      ApprovalTimeoutError,
    );
  });

  it('aborts an in-flight status request when its caller cancels', async () => {
    vi.stubGlobal('fetch', stalledFetch());
    const controller = new AbortController();
    const pending = approvalStatusBeforeDeadline(inflow(), 'approval-1', Date.now() + 1_000, [controller.signal]);

    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(ApprovalCancelledError);
  });

  it('rejects pre-cancelled and expired polling without starting a request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const controller = new AbortController();
    controller.abort();

    await expect(
      approvalStatusBeforeDeadline(inflow(), 'approval-1', Date.now() + 1_000, [controller.signal]),
    ).rejects.toBeInstanceOf(ApprovalCancelledError);
    await expect(approvalStatusBeforeDeadline(inflow(), 'approval-1', Date.now(), [])).rejects.toBeInstanceOf(
      ApprovalTimeoutError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('preserves non-timeout status failures', async () => {
    const failure = new Error('offline');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);

    await expect(approvalStatusBeforeDeadline(inflow(), 'approval-1', Date.now() + 1_000, [])).rejects.toBe(failure);
  });

  it('normalizes non-Error authentication failures while a request is abortable', async () => {
    const client = inflow();
    vi.spyOn(client, 'platformAuthenticationHeaders').mockRejectedValue('authentication unavailable');

    await expect(approvalStatus(client, 'approval-1', new AbortController().signal)).rejects.toMatchObject({
      cause: 'authentication unavailable',
      message: 'Approval authentication failed.',
    });
  });

  it('preserves Error authentication failures while a request is abortable', async () => {
    const client = inflow();
    const failure = new Error('authentication unavailable');
    vi.spyOn(client, 'platformAuthenticationHeaders').mockRejectedValue(failure);

    await expect(approvalStatus(client, 'approval-1', new AbortController().signal)).rejects.toBe(failure);
  });

  it('normalizes non-Error abort reasons received during authentication', async () => {
    const client = inflow();
    vi.spyOn(client, 'platformAuthenticationHeaders').mockReturnValue(new Promise(() => undefined));
    const controller = new AbortController();
    const pending = approvalStatus(client, 'approval-1', controller.signal);

    controller.abort('caller stopped');

    await expect(pending).rejects.toMatchObject({
      cause: 'caller stopped',
      message: 'Approval request aborted.',
    });
  });

  it('bounds best-effort cancellation requests and ignores their failures', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    await expect(cancelApproval(inflow(), 'approval-1')).resolves.toBeUndefined();

    expect(fetchSpy).toHaveBeenCalledWith(
      new URL('/v1/approvals/approval-1/cancel', 'https://platform.example'),
      expect.objectContaining({ method: 'POST', signal: expect.any(AbortSignal) as AbortSignal }),
    );
  });

  it('supports completed and cancelled polling delays', async () => {
    await expect(approvalSleep(1, [undefined])).resolves.toBeUndefined();
    const controller = new AbortController();
    const sleeping = approvalSleep(10_000, [controller.signal]);
    controller.abort();

    await expect(sleeping).rejects.toBeInstanceOf(ApprovalCancelledError);
  });

  it('caps polling delays at the remaining deadline', () => {
    vi.spyOn(Date, 'now').mockReturnValue(100);

    expect(remainingApprovalDelay(200, 30)).toBe(30);
    expect(remainingApprovalDelay(110, 30)).toBe(10);
    expect(remainingApprovalDelay(90, 30)).toBe(0);
  });
});
