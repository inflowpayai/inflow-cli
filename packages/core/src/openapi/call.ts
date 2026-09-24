import { parseChallengeHeaders } from '@inflowpayai/mpp';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import { buildBodyAttachment } from '../flows/x402-pay.js';
import {
  prepareOpenApiRequest,
  previewOpenApiRequest,
  type OpenApiPreparationInput,
  type PreparedOpenApiRequest,
} from './prepare.js';
import { selectOpenApiOperation } from './operations.js';
import { fetchPublicRequest, publicDocumentUrl, type PublicDocumentFetch } from './public-fetch.js';
import type { OpenApiDescription, OpenApiOperation } from './reader.js';

export interface OpenApiCallInput extends OpenApiPreparationInput {
  outputFile?: string | undefined;
  showBody?: boolean;
  timeout?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export class OpenApiCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OpenApiCallError';
  }
}

export function openApiHandoff(
  prepared: PreparedOpenApiRequest,
  operation: OpenApiOperation,
  commands: Array<'mpp' | 'x402' | 'aep'>,
) {
  const preview = previewOpenApiRequest(prepared, operation);
  return commands.map((command) => ({
    command: [command, command === 'aep' ? 'fetch' : 'pay'],
    url: preview.request.url,
    options: {
      method: preview.request.method,
      header: Object.entries(preview.request.headers).map(([name, value]) => `${name}: ${value}`),
      ...(preview.request.body === undefined ? {} : { data: preview.request.body }),
    },
    requiredInputs: preview.redactions,
    message:
      'Run explicitly with the original input values. This makes a new request; it does not resume the previous response.',
  }));
}

function paymentProtocols(response: Response): Array<'mpp' | 'x402'> {
  const protocols: Array<'mpp' | 'x402'> = [];
  const mpp = response.headers.get('www-authenticate');
  if (mpp !== null) {
    try {
      if (parseChallengeHeaders([mpp]).length > 0) protocols.push('mpp');
    } catch {
      /* Unrecognized challenges do not identify a supported protocol. */
    }
  }
  const x402 = response.headers.get('payment-required');
  if (x402 !== null) {
    try {
      const decoded = decodePaymentRequiredHeader(x402);
      if (Array.isArray(decoded.accepts) && decoded.accepts.length > 0) protocols.push('x402');
    } catch {
      /* Unrecognized challenges do not identify a supported protocol. */
    }
  }
  return protocols;
}

async function responseBytes(response: Response, maximum: number): Promise<Uint8Array> {
  const reader: ReadableStreamDefaultReader<Uint8Array> | undefined = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum)
        throw new OpenApiCallError(
          'OPENAPI_RESPONSE_TOO_LARGE',
          'The response exceeded the size limit. The operation may have completed; do not automatically retry.',
        );
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export async function callOpenApiOperation(
  document: OpenApiDescription,
  input: OpenApiCallInput,
  fetch: PublicDocumentFetch = fetchPublicRequest,
) {
  const prepared = prepareOpenApiRequest(document, input);
  const operation = selectOpenApiOperation(document, input);
  const preview = previewOpenApiRequest(prepared, operation);
  const base = {
    source: prepared.source,
    operation: prepared.operation,
    request: preview.request,
    redactions: preview.redactions,
  };
  if (operation.payment?.advertised)
    return {
      ...base,
      outcome: 'payment-required' as const,
      sent: false as const,
      payment: operation.payment,
      next: openApiHandoff(prepared, operation, operation.payment.protocols),
    };
  const timeout = input.timeout ?? 30;
  const maximum = input.maxResponseBytes ?? 16 * 1024 * 1024;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 900 || !Number.isSafeInteger(maximum) || maximum <= 0)
    throw new OpenApiCallError(
      'OPENAPI_CALL_INPUT_INVALID',
      'Timeout must be between 0 and 900 seconds and the response size limit must be a positive integer.',
    );
  const signal = AbortSignal.any([
    AbortSignal.timeout(Math.ceil(timeout * 1000)),
    ...(input.signal === undefined ? [] : [input.signal]),
  ]);
  if (signal.aborted)
    throw new OpenApiCallError('OPENAPI_CALL_CANCELLED', 'The request was cancelled before it was sent.');
  let response: Response;
  let bytes: Uint8Array;
  try {
    response = await fetch(publicDocumentUrl(prepared.request.url), {
      method: prepared.request.method,
      headers: prepared.request.headers,
      ...(prepared.request.body === undefined ? {} : { body: prepared.request.body }),
      redirect: 'manual',
      credentials: 'omit',
      signal,
    });
    bytes = await responseBytes(response, maximum);
  } catch (error) {
    if (error instanceof OpenApiCallError) throw error;
    throw new OpenApiCallError(
      'OPENAPI_CALL_OUTCOME_UNKNOWN',
      'The request did not complete. The server may have performed the operation; do not automatically retry.',
    );
  }
  const protocols = response.status === 402 ? paymentProtocols(response) : [];
  const aep = response.status === 401 && /^AEP(?:\s|$)/i.test(response.headers.get('www-authenticate') ?? '');
  let attachment: Awaited<ReturnType<typeof buildBodyAttachment>>;
  try {
    attachment = await buildBodyAttachment(bytes, input.showBody ?? true, input.outputFile);
  } catch {
    throw new OpenApiCallError(
      'OPENAPI_OUTPUT_WRITE_FAILED',
      'The response was received but could not be saved. Do not repeat the operation merely to retry writing the file.',
    );
  }
  return {
    ...base,
    outcome:
      response.status === 402
        ? ('payment-required' as const)
        : aep
          ? ('authentication-required' as const)
          : response.ok
            ? ('response' as const)
            : ('http-error' as const),
    sent: true as const,
    status: response.status,
    content_type: response.headers.get('content-type'),
    response_size_bytes: bytes.byteLength,
    ...(attachment.body === undefined ? {} : { body: attachment.body }),
    ...(attachment.bodyBase64 === undefined ? {} : { body_base64: attachment.bodyBase64 }),
    ...(attachment.outputSavedTo === undefined ? {} : { output_saved_to: attachment.outputSavedTo }),
    ...(response.status === 402 ? { payment: { protocols } } : {}),
    next: openApiHandoff(prepared, operation, aep ? ['aep'] : protocols),
  };
}
