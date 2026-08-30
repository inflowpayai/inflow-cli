import { createHash } from 'node:crypto';
import { InflowApiError, InflowTransportError } from './errors.js';
import type {
  ICliCapabilitiesResource,
  ITapResource,
  TapOperation,
  TapSignatureResponse,
} from './resources/interfaces.js';

const TAP_FEATURE = 'visa_tap';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface TapHttpRequest {
  body?: string | Uint8Array;
  headers?: ConstructorParameters<typeof Headers>[0];
  method: string;
  operation: TapOperation;
  serviceId?: string;
  signal?: AbortSignal;
  transactionId?: string;
  url: string;
}

export interface TapHttpResponse {
  response: Response;
  tapEvidenceId?: string;
}

export interface TapRequestTransportOptions {
  capabilities: ICliCapabilitiesResource;
  fetch?: typeof globalThis.fetch;
  followRedirects?: boolean;
  maxRedirects?: number;
  redirectAllowed?: (from: URL, to: URL) => boolean;
  tap: ITapResource;
}

export interface TapFetchOptions extends TapRequestTransportOptions {
  operation: TapOperation;
  serviceId?: string;
  transactionId?: string;
}

export interface TapRequestTransport {
  request(input: TapHttpRequest): Promise<TapHttpResponse>;
}

export function createTapFetch(options: TapFetchOptions): typeof globalThis.fetch {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  return async (input, init) => {
    const request = new Request(input, init);
    const body = request.body === null ? undefined : new Uint8Array(await request.clone().arrayBuffer());
    const normalized = normalizedRequest({
      ...(body === undefined ? {} : { body }),
      headers: request.headers,
      method: request.method,
      operation: options.operation,
      ...(options.serviceId === undefined ? {} : { serviceId: options.serviceId }),
      signal: request.signal,
      ...(options.transactionId === undefined ? {} : { transactionId: options.transactionId }),
      url: request.url,
    });
    const signed = await signedHeaders(options.capabilities, options.tap, normalized);
    return fetchImpl(normalized.url, {
      ...(normalized.body === undefined ? {} : { body: wireBody(normalized.body) }),
      headers: signed.headers,
      method: normalized.method,
      redirect: 'manual',
      ...(normalized.signal === undefined ? {} : { signal: normalized.signal }),
    });
  };
}

export function createTapRequestTransport(options: TapRequestTransportOptions): TapRequestTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const followRedirects = options.followRedirects ?? true;
  const maxRedirects = options.maxRedirects ?? 5;
  const redirectAllowed = options.redirectAllowed ?? (() => true);
  if (maxRedirects < 0) throw new InflowTransportError('TAP maxRedirects must be >= 0.');

  return {
    request: async (input) => {
      let current = normalizedRequest(input);
      const visited = new Set<string>();

      for (let redirects = 0; ; redirects += 1) {
        if (visited.has(current.url)) throw new InflowTransportError('TAP request redirect loop detected.');
        visited.add(current.url);

        const signed = await signedHeaders(options.capabilities, options.tap, current);
        const response = await fetchImpl(current.url, {
          ...(current.body === undefined ? {} : { body: wireBody(current.body) }),
          headers: signed.headers,
          method: current.method,
          redirect: 'manual',
          ...(current.signal === undefined ? {} : { signal: current.signal }),
        });
        if (!REDIRECT_STATUSES.has(response.status)) {
          return {
            response,
            ...(signed.signature?.tapEvidenceId === undefined ? {} : { tapEvidenceId: signed.signature.tapEvidenceId }),
          };
        }
        if (!followRedirects) {
          return {
            response,
            ...(signed.signature?.tapEvidenceId === undefined ? {} : { tapEvidenceId: signed.signature.tapEvidenceId }),
          };
        }
        if (redirects >= maxRedirects) throw new InflowTransportError('TAP request exceeded its redirect limit.');

        const location = response.headers.get('location');
        if (location === null) {
          return {
            response,
            ...(signed.signature?.tapEvidenceId === undefined ? {} : { tapEvidenceId: signed.signature.tapEvidenceId }),
          };
        }
        const from = new URL(current.url);
        const to = new URL(location, from);
        if (!redirectAllowed(from, to)) {
          throw new InflowTransportError(`TAP request redirect is not allowed: ${to.origin}`);
        }
        current = normalizedRequest(redirectedRequest(current, to, response.status));
      }
    },
  };
}

function normalizedRequest(input: TapHttpRequest): TapHttpRequest {
  const url = new URL(input.url);
  if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) {
    throw new InflowTransportError('TAP request URL cannot contain credentials or a fragment.');
  }
  const headers = new Headers(input.headers);
  requireNoSignatureHeaders(headers);
  if (input.body === undefined && headers.has('Content-Digest')) {
    throw new InflowTransportError('A TAP request without a body cannot supply Content-Digest.');
  }
  if (!/^[A-Z]+$/.test(input.method)) {
    throw new InflowTransportError('TAP request method must use its exact uppercase wire representation.');
  }
  return { ...input, headers, url: url.toString() };
}

function redirectedRequest(input: TapHttpRequest, target: URL, status: number): TapHttpRequest {
  const switchToGet =
    status === 303 ? input.method !== 'HEAD' : (status === 301 || status === 302) && input.method === 'POST';
  const source = new URL(input.url);
  const headers = source.origin === target.origin ? new Headers(input.headers) : safeCrossOriginHeaders(input.headers);
  removeRedirectCredentials(headers);
  headers.delete('Content-Digest');
  if (switchToGet) {
    headers.delete('Content-Type');
    headers.delete('Content-Length');
    const { body: _body, ...withoutBody } = input;
    return { ...withoutBody, headers, method: 'GET', url: target.toString() };
  }
  return { ...input, headers, url: target.toString() };
}

function removeRedirectCredentials(headers: Headers): void {
  for (const name of [
    'AEP-Authorization',
    'Authorization',
    'Cookie',
    'PAYMENT-SIGNATURE',
    'Proxy-Authorization',
    'Signature',
    'Signature-Input',
    'X-PAYMENT',
  ]) {
    headers.delete(name);
  }
}

function safeCrossOriginHeaders(input: ConstructorParameters<typeof Headers>[0]): Headers {
  const source = new Headers(input);
  const headers = new Headers();
  for (const name of ['Accept', 'Content-Type']) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

async function signedHeaders(
  capabilities: ICliCapabilitiesResource,
  tap: ITapResource,
  input: TapHttpRequest,
): Promise<{ headers: Headers; signature?: TapSignatureResponse }> {
  const headers = new Headers(input.headers);
  if (!(await capabilities.has(TAP_FEATURE, input.signal === undefined ? {} : { signal: input.signal }))) {
    return { headers };
  }

  const request = {
    method: input.method,
    operation: input.operation,
    ...(input.serviceId === undefined ? {} : { serviceId: input.serviceId }),
    targetUrl: input.url,
    ...(input.transactionId === undefined ? {} : { transactionId: input.transactionId }),
  };
  try {
    let signature: TapSignatureResponse;
    if (input.body === undefined) {
      signature = await tap.sign(request, input.signal === undefined ? {} : { signal: input.signal });
    } else {
      const contentType = headers.get('Content-Type');
      if (contentType === null || contentType.length === 0) {
        throw new InflowTransportError('A TAP request with a body requires Content-Type.');
      }
      const contentDigest = digest(input.body);
      const existingDigest = headers.get('Content-Digest');
      if (existingDigest !== null && existingDigest !== contentDigest) {
        throw new InflowTransportError('The supplied Content-Digest does not match the TAP request body.');
      }
      const prepared = await tap.sign(
        { ...request, prepare: true },
        input.signal === undefined ? {} : { signal: input.signal },
      );
      if (prepared.signingRequestId === undefined) {
        throw new InflowTransportError('The TAP signing response is missing signingRequestId.');
      }
      signature = await tap.finalize(
        prepared.signingRequestId,
        contentDigest,
        contentType,
        input.signal === undefined ? {} : { signal: input.signal },
      );
      headers.set('Content-Digest', contentDigest);
    }
    if (signature.signature === undefined || signature.signatureInput === undefined) {
      throw new InflowTransportError('The TAP signing response is missing signature fields.');
    }
    headers.set('Signature', signature.signature);
    headers.set('Signature-Input', signature.signatureInput);
    return { headers, signature };
  } catch (error) {
    if (error instanceof InflowApiError && error.code === 'TAP_NOT_ELIGIBLE') return { headers };
    throw error;
  }
}

function digest(body: string | Uint8Array): string {
  return `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
}

function wireBody(body: string | Uint8Array): NonNullable<RequestInit['body']> {
  return typeof body === 'string' ? body : Buffer.from(body);
}

function requireNoSignatureHeaders(headers: Headers): void {
  if (headers.has('Signature') || headers.has('Signature-Input')) {
    throw new InflowTransportError('TAP signature headers are managed by InFlow.');
  }
}
