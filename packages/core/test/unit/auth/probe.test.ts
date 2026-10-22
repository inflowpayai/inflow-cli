import { describe, expect, it, vi } from 'vitest';
import { probeSession } from '../../../src/auth/probe.js';
import { InflowApiError, InflowTransportError } from '../../../src/errors.js';
import type { IUserResource } from '../../../src/resources/interfaces.js';
import type { User } from '../../../src/types/index.js';

const sampleUser: User = {
  userId: 'u-1',
  email: 'ada@example.test',
  firstName: null,
  lastName: null,
  username: null,
  mobile: null,
  locale: 'EN_US',
  timezone: 'UTC',
  created: '2026-01-01T00:00:00Z',
  updated: '2026-01-01T00:00:00Z',
};

function resource(retrieve: (opts?: { signal?: AbortSignal }) => Promise<User>): IUserResource {
  return { retrieve: vi.fn(retrieve) };
}

describe('probeSession', () => {
  it.each([
    new InflowTransportError('aborted', { cause: new DOMException('aborted', 'AbortError') }),
    new InflowTransportError('offline', { cause: new Error('connection refused') }),
    new InflowTransportError('offline'),
    new InflowApiError('unavailable', { status: 503 }),
  ])('distinguishes transport cancellation from authentication rejection: %s', async (error) => {
    const result = await probeSession(
      resource(() => Promise.reject(error)),
      { timeoutMs: 1_000 },
    );
    expect(result).toEqual(
      error.cause instanceof Error && error.cause.name === 'AbortError'
        ? { ok: false, reason: 'timeout' }
        : { ok: false, reason: 'other', error },
    );
  });

  it('returns ok when retrieve resolves before the deadline', async () => {
    const r = resource(() => Promise.resolve(sampleUser));
    const result = await probeSession(r, { timeoutMs: 1_000 });
    expect(result).toEqual({ ok: true, user: sampleUser });
  });

  it('passes a non-aborted AbortSignal into retrieve', async () => {
    let observedSignal: AbortSignal | undefined;
    const r = resource((opts) => {
      observedSignal = opts?.signal;
      return Promise.resolve(sampleUser);
    });
    await probeSession(r, { timeoutMs: 1_000 });
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal?.aborted).toBe(false);
  });

  it('returns { reason: "unauthenticated" } on 401', async () => {
    const r = resource(() => Promise.reject(new InflowApiError('unauthorized', { status: 401, code: 'unauthorized' })));
    const result = await probeSession(r, { timeoutMs: 1_000 });
    expect(result).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('returns { reason: "timeout" } when the signal aborts before retrieve resolves', async () => {
    const r = resource(
      (opts) =>
        new Promise<User>((_, reject) => {
          opts?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const result = await probeSession(r, { timeoutMs: 20 });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  it('returns { reason: "timeout" } when retrieve throws an AbortError-shaped transport error', async () => {
    const abortCause = new Error('aborted');
    abortCause.name = 'AbortError';
    const r = resource(
      (opts) =>
        new Promise<User>((_, reject) => {
          opts?.signal?.addEventListener(
            'abort',
            () => reject(new InflowTransportError('Request aborted.', { cause: abortCause })),
            { once: true },
          );
        }),
    );
    const result = await probeSession(r, { timeoutMs: 20 });
    expect(result).toEqual({ ok: false, reason: 'timeout' });
  });

  it('returns { reason: "other" } for non-401 thrown errors', async () => {
    const error = new Error('boom');
    const r = resource(() => Promise.reject(error));
    const result = await probeSession(r, { timeoutMs: 1_000 });
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe('other');
    expect((result as { error: unknown }).error).toBe(error);
  });
});
