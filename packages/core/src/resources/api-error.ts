import { InflowApiError } from '../errors.js';
import type { ApiResponse } from '../utils/api-client.js';
import { redactRawBody } from '../utils/redact.js';

interface ProblemError {
  code?: unknown;
  message?: unknown;
}

interface ProblemEnvelope {
  errors?: unknown;
  install_url?: unknown;
  current_version?: unknown;
  minimum_supported_version?: unknown;
  latest_version?: unknown;
}

const VERSION_UNSUPPORTED_CODE = 'VERSION_UNSUPPORTED';
const DEFAULT_INSTALL_URL = 'https://inflowcli.ai/';

function firstProblem(data: unknown): ProblemError | undefined {
  const envelope = data as ProblemEnvelope | null;
  if (!Array.isArray(envelope?.errors)) return undefined;
  const first: unknown = envelope.errors[0];
  if (first === null || typeof first !== 'object') return undefined;
  return first;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function versionUnsupportedMessage(data: unknown): string {
  const envelope = data as ProblemEnvelope | null;
  const installUrl = stringField(envelope?.install_url) ?? DEFAULT_INSTALL_URL;
  return `This InFlow CLI version is no longer supported.\nInstall the latest version: ${installUrl}`;
}

export function isVersionUnsupportedResponse(data: unknown): boolean {
  return stringField(firstProblem(data)?.code) === VERSION_UNSUPPORTED_CODE;
}

export function createApiError(response: ApiResponse, fallbackPrefix: string): InflowApiError {
  const problem = firstProblem(response.data);
  const code = stringField(problem?.code);
  const message = stringField(problem?.message);
  const fallback = redactRawBody(response.rawBody) || 'unknown error';
  const errorMessage =
    code === VERSION_UNSUPPORTED_CODE
      ? versionUnsupportedMessage(response.data)
      : `${fallbackPrefix} (${String(response.status)}): ${message ?? fallback}`;

  return new InflowApiError(errorMessage, {
    status: response.status,
    ...(code !== undefined ? { code } : {}),
    rawBody: response.rawBody,
    details: response.data,
  });
}
