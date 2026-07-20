import { type InflowOptions, type ResolvedInflowSdkConfig, resolveInflowSdkConfig } from '../config.js';
import type { Balance } from '../types/index.js';
import { InflowApiClient } from '../utils/api-client.js';
import { normalizeDecimalString } from '../utils/decimal.js';
import { createApiError } from './api-error.js';
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
    const response = await this.api.get('/v1/balances', requestOptions);
    const { status, data } = response;
    if (status < 200 || status >= 300) {
      throw createApiError(response, 'Failed to list balances');
    }
    const body = data as BalancesResponse | null;
    return (body?.balances ?? []).map((balance) => ({
      ...balance,
      available: normalizeDecimalString(balance.available),
    }));
  }
}
