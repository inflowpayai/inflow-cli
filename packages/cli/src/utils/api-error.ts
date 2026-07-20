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
  const apiError = apiErrorLike(error);
  if (apiError === undefined) return;
  if (apiError.code === 'VERSION_UNSUPPORTED' && typeof apiError.message === 'string') {
    return { code: apiError.code, message: apiError.message };
  }
  if (apiError.status === 401) {
    return MISSING_SESSION_ERROR;
  }
}
