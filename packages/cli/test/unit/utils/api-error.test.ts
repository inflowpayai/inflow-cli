import { InflowApiError, SecureStorageError } from '@inflowpayai/inflow-core';
import { describe, expect, it } from 'vitest';
import { authenticatedApiError } from '../../../src/utils/api-error.js';

describe('authenticatedApiError', () => {
  it.each([
    ['vault_locked', 'VAULT_LOCKED', 'The InFlow vault is locked. A human must run `inflow vault unlock` first.'],
    [
      'vault_not_initialized',
      'VAULT_NOT_INITIALIZED',
      'The InFlow vault is not initialized. A human must run `inflow vault unlock` first.',
    ],
  ] as const)('maps %s to an actionable agent error', (secureStorageCode, code, message) => {
    expect(authenticatedApiError(new SecureStorageError(secureStorageCode, 'storage unavailable'))).toEqual({
      code,
      message,
    });
  });

  it('maps rejected credentials to the login recovery frame', () => {
    expect(authenticatedApiError(new InflowApiError('Unauthorized', { status: 401 }))).toMatchObject({
      code: 'NOT_AUTHENTICATED',
    });
  });

  it('maps unsupported CLI versions structurally', () => {
    expect(
      authenticatedApiError({
        code: 'VERSION_UNSUPPORTED',
        message: 'Upgrade required.',
        status: 426,
      }),
    ).toEqual({
      code: 'VERSION_UNSUPPORTED',
      message: 'Upgrade required.',
    });
  });

  it('ignores non-API errors', () => {
    expect(authenticatedApiError(null)).toBeUndefined();
    expect(authenticatedApiError('nope')).toBeUndefined();
    expect(authenticatedApiError(new Error('boom'))).toBeUndefined();
  });
});
