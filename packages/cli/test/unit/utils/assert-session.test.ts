import { type AuthTokens, Inflow, MemoryStorage } from '@inflowpayai/inflow-core';
import { Errors } from 'incur';
import { describe, expect, it, vi } from 'vitest';
import { assertSession, assertSessionGuard, MISSING_SESSION_ERROR } from '../../../src/utils/assert-session.js';

const sampleAuth: AuthTokens = {
  access_token: 'a',
  refresh_token: 'r',
  token_type: 'Bearer',
  expires_in: 3600,
  expires_at: Date.now() + 3600 * 1000,
};

function makeInflow(opts: { storage: MemoryStorage; apiKey?: string }): Inflow {
  return new Inflow({
    authStorage: opts.storage,
    environment: 'sandbox',
    cliClientId: 'test',
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
  });
}

describe('assertSessionGuard', () => {
  it('calls c.error with MISSING_SESSION_ERROR when no session is present', () => {
    const storage = new MemoryStorage();
    const inflow = makeInflow({ storage });
    const error = vi.fn<(err: unknown) => never>(() => {
      throw new Error('aborted');
    });

    expect(() => assertSessionGuard({ error }, storage, inflow)).toThrow('aborted');
    expect(error).toHaveBeenCalledWith(MISSING_SESSION_ERROR);
  });

  it('throws an IncurError with NOT_AUTHENTICATED when c.error returns instead of throwing (real incur runtime)', () => {
    const storage = new MemoryStorage();
    const inflow = makeInflow({ storage });
    const error = vi.fn<(err: unknown) => never>(() => undefined as never);

    let captured: unknown = null;
    try {
      assertSessionGuard({ error }, storage, inflow);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as { code?: string }).code).toBe('NOT_AUTHENTICATED');
    expect((captured as Error).message).toContain('Not authenticated.');
  });

  it('throws an IncurError when c.error returns instead of throwing (real incur shape)', () => {
    const storage = new MemoryStorage();
    const inflow = makeInflow({ storage });
    const error = vi.fn<(err: unknown) => never>(() => ({ sentinel: 'error' }) as never);

    let thrown: unknown;
    try {
      assertSessionGuard({ error }, storage, inflow);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Errors.IncurError);
    const incur = thrown as Errors.IncurError;
    expect(incur.code).toBe(MISSING_SESSION_ERROR.code);
    expect(incur.message).toBe(MISSING_SESSION_ERROR.message);
    expect(error).toHaveBeenCalledWith(MISSING_SESSION_ERROR);
  });

  it('passes when authStorage has a saved token', () => {
    const storage = new MemoryStorage(sampleAuth);
    const inflow = makeInflow({ storage });
    const error = vi.fn<(err: unknown) => never>(() => {
      throw new Error('aborted');
    });

    expect(() => assertSessionGuard({ error }, storage, inflow)).not.toThrow();
    expect(error).not.toHaveBeenCalled();
  });

  it('passes when the Inflow client has an apiKey, regardless of storage', () => {
    const storage = new MemoryStorage();
    const inflow = makeInflow({ storage, apiKey: 'inflow_test_key' });
    const error = vi.fn<(err: unknown) => never>(() => {
      throw new Error('aborted');
    });

    expect(() => assertSessionGuard({ error }, storage, inflow)).not.toThrow();
    expect(error).not.toHaveBeenCalled();
  });
});

describe('assertSession (incur middleware)', () => {
  it('calls c.error and skips next when no session is present', () => {
    const storage = new MemoryStorage();
    const inflow = makeInflow({ storage });
    const next = vi.fn();
    const error = vi.fn();

    void assertSession(storage, inflow)({ error } as never, next as never);

    expect(error).toHaveBeenCalledWith(MISSING_SESSION_ERROR);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next when a session is present', () => {
    const storage = new MemoryStorage(sampleAuth);
    const inflow = makeInflow({ storage });
    const next = vi.fn();
    const error = vi.fn();

    void assertSession(storage, inflow)({ error } as never, next as never);

    expect(next).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
  });
});
