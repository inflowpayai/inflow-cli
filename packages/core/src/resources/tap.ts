import type { TapSignatureRequest, TapSignatureResponse, ITapResource } from './interfaces.js';
import type { InflowApiClient } from '../utils/api-client.js';
import { createApiError } from './api-error.js';
import { InflowApiError } from '../errors.js';

export class TapResource implements ITapResource {
  constructor(private readonly api: InflowApiClient) {}

  async finalize(
    signingRequestId: string,
    contentDigest: string,
    contentType: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TapSignatureResponse> {
    const response = await this.api.post(
      `/v1/tap/signatures/${encodeURIComponent(signingRequestId)}/finalize`,
      { contentDigest, contentType },
      options.signal === undefined ? {} : { signal: options.signal },
    );
    return parseResponse(response, 'Failed to finalize TAP signature');
  }

  async sign(request: TapSignatureRequest, options: { signal?: AbortSignal } = {}): Promise<TapSignatureResponse> {
    const response = await this.api.post(
      '/v1/tap/signatures',
      request,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    return parseResponse(response, 'Failed to issue TAP signature');
  }
}

function parseResponse(response: Awaited<ReturnType<InflowApiClient['post']>>, fallback: string): TapSignatureResponse {
  if (response.status < 200 || response.status >= 300) throw createTapError(response, fallback);
  const value = response.data as Partial<TapSignatureResponse> | null;
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.created !== 'number' ||
    typeof value.expires !== 'number' ||
    typeof value.keyid !== 'string' ||
    typeof value.nonce !== 'string'
  ) {
    throw createApiError(response, fallback);
  }
  return value as TapSignatureResponse;
}

function createTapError(response: Awaited<ReturnType<InflowApiClient['post']>>, fallback: string): InflowApiError {
  const problem = response.data as { code?: unknown; detail?: unknown } | null;
  if (problem !== null && typeof problem === 'object') {
    const code = typeof problem.code === 'string' && problem.code.length > 0 ? problem.code : undefined;
    const detail = typeof problem.detail === 'string' && problem.detail.length > 0 ? problem.detail : undefined;
    if (code !== undefined || detail !== undefined) {
      return new InflowApiError(detail ?? `${fallback} (${String(response.status)})`, {
        status: response.status,
        ...(code === undefined ? {} : { code }),
        rawBody: response.rawBody,
        details: response.data,
      });
    }
  }
  return createApiError(response, fallback);
}
