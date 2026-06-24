import { type InflowOptions, type ResolvedInflowSdkConfig, resolveInflowSdkConfig } from '../config.js';
import { InflowApiError } from '../errors.js';
import type { Balance } from '../types/index.js';
import { InflowApiClient } from '../utils/api-client.js';
import { normalizeDecimalString } from '../utils/decimal.js';
import { redactRawBody } from '../utils/redact.js';
import type { IBalanceResource } from './interfaces.js';

interface BalancesResponse {
  balances: Balance[];
}

export class BalanceResource implements IBalanceResource {
  private readonly api: InflowApiClient;

  constructor(options: InflowOptions = {}, resolvedConfig?: ResolvedInflowSdkConfig) {
    const config: ResolvedInflowSdkConfig = resolvedConfig ?? resolveInflowSdkConfig(options);
    this.api = new InflowApiClient(config, config.apiBaseUrl);
  }

  async list(options: { signal?: AbortSignal } = {}): Promise<Balance[]> {
    const requestOptions = options.signal !== undefined ? { signal: options.signal } : {};
    const { status, data, rawBody } = await this.api.get('/v1/balances', requestOptions);
    if (status < 200 || status >= 300) {
      throw new InflowApiError(
        `Failed to list balances (${String(status)}): ${redactRawBody(rawBody) || 'unknown error'}`,
        {
          status,
          rawBody,
          details: data,
        },
      );
    }
    const body = data as BalancesResponse | null;
    return (body?.balances ?? []).map((balance) => ({
      ...balance,
      available: normalizeDecimalString(balance.available),
    }));
  }
}
