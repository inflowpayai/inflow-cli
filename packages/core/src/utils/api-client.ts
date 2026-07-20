import { type ResolvedInflowSdkConfig, requireFetchImplementation } from '../config.js';
import { InflowTransportError } from '../errors.js';
import { redactBodyParams, redactHeaders, redactJsonBody } from './redact.js';

/** @internal */
export interface ApiResponse {
  status: number;
  data: unknown;
  rawBody: string;
}

/** @internal */
export interface RequestOptions {
  retries?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  skipAuth?: boolean;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

declare const __INFLOW_CORE_VERSION__: string;
const SDK_USER_AGENT = `@inflowpayai/inflow-core/${
  typeof __INFLOW_CORE_VERSION__ === 'string' ? __INFLOW_CORE_VERSION__ : '0.0.0'
}`;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(handle);
      reject(new InflowTransportError('Request aborted.'));
    };
    if (signal?.aborted) {
      reject(new InflowTransportError('Request aborted.'));
      return;
    }
    const handle = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface SendOptions {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
  timeoutMs: number;
  externalSignal?: AbortSignal;
}

/** @internal */
export class InflowApiClient {
  private readonly config: ResolvedInflowSdkConfig;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(config: ResolvedInflowSdkConfig, baseUrl: string) {
    this.config = config;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetchImpl = requireFetchImplementation(config);
  }

  async get(path: string, options: RequestOptions = {}): Promise<ApiResponse> {
    return this.request('GET', path, undefined, options);
  }

  async post(path: string, body: unknown, options: RequestOptions = {}): Promise<ApiResponse> {
    return this.request('POST', path, body, options);
  }

  async postForm(path: string, params: Record<string, string>, options: RequestOptions = {}): Promise<ApiResponse> {
    const headers = { ...options.headers };
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const body = new URLSearchParams(params).toString();

    return this.sendWithRetries('POST', this.urlFor(path), headers, body, params, options, true);
  }

  async request(method: string, path: string, body: unknown, options: RequestOptions = {}): Promise<ApiResponse> {
    const headers: Record<string, string> = { ...options.headers };
    let serializedBody: string | undefined;

    if (body !== undefined) {
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
      serializedBody = typeof body === 'string' ? body : JSON.stringify(body);
    }

    return this.sendWithRetries(method, this.urlFor(path), headers, serializedBody, body, options, false);
  }

  private urlFor(path: string): string {
    if (!path.startsWith('/')) {
      throw new InflowTransportError(`InflowApiClient: path must start with '/' (got: ${path}).`);
    }
    return `${this.baseUrl}${path}`;
  }

  async authenticationHeaders(): Promise<Record<string, string>> {
    const mode = this.config.authMode;
    switch (mode.type) {
      case 'apiKey':
        return { 'X-API-KEY': mode.apiKey };
      case 'dynamicBearer': {
        const token = await mode.getAccessToken();
        if (typeof token !== 'string' || token.length === 0) {
          throw new InflowTransportError('InflowApiClient: getAccessToken resolved to a non-string or empty value.');
        }
        return { Authorization: `Bearer ${token}` };
      }
      case 'staticBearer':
        return { Authorization: `Bearer ${mode.accessToken}` };
      case 'anonymous':
        return {};
    }
  }

  private async sendOnce(opts: SendOptions): Promise<ApiResponse> {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), opts.timeoutMs);
    const onExternalAbort = (): void => controller.abort();
    if (opts.externalSignal) {
      if (opts.externalSignal.aborted) {
        controller.abort();
      } else {
        opts.externalSignal.addEventListener('abort', onExternalAbort, {
          once: true,
        });
      }
    }

    let response: Response;
    try {
      const init: RequestInit = {
        method: opts.method,
        headers: opts.headers,
        signal: controller.signal,
      };
      if (opts.body !== undefined) {
        init.body = opts.body;
      }
      response = await this.fetchImpl(opts.url, init);
    } catch (error) {
      throw new InflowTransportError(`Request failed: ${opts.method} ${opts.url}`, { cause: error });
    } finally {
      clearTimeout(timeoutHandle);
      opts.externalSignal?.removeEventListener('abort', onExternalAbort);
    }

    const rawBody = await response.text();
    let data: unknown = null;
    if (rawBody.length > 0) {
      try {
        data = JSON.parse(rawBody);
      } catch {
        // non-JSON response (e.g., from load balancer)
      }
    }

    return { status: response.status, data, rawBody };
  }

  private async sendWithRetries(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: string | undefined,
    logBody: unknown,
    options: RequestOptions,
    skipAuthByDefault: boolean,
  ): Promise<ApiResponse> {
    const totalAttempts = options.retries ?? DEFAULT_RETRIES;
    if (totalAttempts < 1) {
      throw new InflowTransportError('InflowApiClient: retries must be >= 1.');
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const skipAuth = options.skipAuth ?? skipAuthByDefault;

    let attempts = 0;
    let lastTransportError: unknown = null;
    let didRetryOn401 = false;
    let overrideAuthHeader: string | undefined;

    while (attempts < totalAttempts) {
      attempts += 1;
      const attemptHeaders: Record<string, string> = {
        Accept: 'application/json',
        'User-Agent': SDK_USER_AGENT,
        ...headers,
      };
      if (!skipAuth) {
        if (overrideAuthHeader !== undefined) {
          attemptHeaders['Authorization'] = overrideAuthHeader;
        } else {
          Object.assign(attemptHeaders, await this.authenticationHeaders());
        }
      }

      if (this.config.verbose) {
        this.logRequest(method, url, attemptHeaders, body, logBody);
      }

      let result: ApiResponse;
      try {
        result = await this.sendOnce({
          method,
          url,
          headers: attemptHeaders,
          body,
          timeoutMs,
          ...(options.signal !== undefined ? { externalSignal: options.signal } : {}),
        });
      } catch (error) {
        lastTransportError = error;
        if (attempts >= totalAttempts) {
          throw error;
        }
        await sleep(backoffMs(attempts), options.signal);
        continue;
      }

      if (this.config.verbose) {
        this.logResponse(result);
      }

      if (
        !skipAuth &&
        result.status === 401 &&
        !didRetryOn401 &&
        this.config.authMode.type === 'dynamicBearer' &&
        attempts < totalAttempts
      ) {
        didRetryOn401 = true;
        const refreshed = await this.config.authMode.getAccessToken({
          forceRefresh: true,
        });
        overrideAuthHeader = `Bearer ${refreshed}`;
        continue;
      }

      if (RETRYABLE_STATUSES.has(result.status) && attempts < totalAttempts) {
        await sleep(backoffMs(attempts), options.signal);
        continue;
      }

      return result;
    }

    throw new InflowTransportError(
      `Request failed after ${String(totalAttempts)} attempts.`,
      lastTransportError !== null ? { cause: lastTransportError } : {},
    );
  }

  private logRequest(
    method: string,
    url: string,
    headers: Record<string, string>,
    serializedBody: string | undefined,
    logBody: unknown,
  ): void {
    this.config.logger.debug(`> ${method} ${url}`);
    this.config.logger.debug(`  Headers: ${JSON.stringify(redactHeaders(headers))}`);
    const isForm = headers['Content-Type'] === 'application/x-www-form-urlencoded';
    if (isForm && logBody !== undefined && logBody !== null && typeof logBody === 'object') {
      const params = logBody as Record<string, string>;
      this.config.logger.debug(JSON.stringify(redactBodyParams(params), null, 2));
    } else if (logBody !== undefined) {
      const redacted = redactJsonBody(logBody);
      this.config.logger.debug(JSON.stringify(redacted, null, 2));
    } else if (serializedBody !== undefined) {
      this.config.logger.debug(serializedBody);
    }
  }

  private logResponse(response: ApiResponse): void {
    this.config.logger.debug(`< ${String(response.status)}`);
    if (response.data !== null) {
      this.config.logger.debug(JSON.stringify(redactJsonBody(response.data), null, 2));
      return;
    }
    this.config.logger.debug(`<non-JSON body, ${String(response.rawBody.length)} bytes>`);
  }
}

function backoffMs(attempt: number): number {
  return 200 * 2 ** (attempt - 1);
}
