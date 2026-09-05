import { SecureStorageError } from '@inflowpayai/inflow-core';
import { MISSING_SESSION_ERROR } from './assert-session.js';

interface CliError {
  code: string;
  message: string;
  cta?: { commands: { command: string; description: string }[] };
}

interface ApiErrorLike {
  code?: unknown;
  status?: unknown;
  message?: unknown;
}

function apiErrorLike(error: unknown): ApiErrorLike | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  return error;
}

export function authenticatedApiError(error: unknown): CliError | undefined {
  if (error instanceof SecureStorageError) {
    if (error.secureStorageCode === 'vault_locked') {
      return {
        code: 'VAULT_LOCKED',
        message: 'The InFlow vault is locked. A human must run `inflow vault unlock` first.',
      };
    }
    if (error.secureStorageCode === 'vault_not_initialized') {
      return {
        code: 'VAULT_NOT_INITIALIZED',
        message: 'The InFlow vault is not initialized. A human must run `inflow vault unlock` first.',
      };
    }
  }
  const apiError = apiErrorLike(error);
  if (apiError === undefined) return;
  if (apiError.code === 'VERSION_UNSUPPORTED' && typeof apiError.message === 'string') {
    return { code: apiError.code, message: apiError.message };
  }
  if (apiError.status === 401) {
    return MISSING_SESSION_ERROR;
  }
}
