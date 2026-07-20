import { type InflowOptions, type ResolvedInflowSdkConfig, resolveInflowSdkConfig } from '../config.js';
import type { DepositAddresses } from '../types/index.js';
import { InflowApiClient } from '../utils/api-client.js';
import { createApiError } from './api-error.js';
import type { IDepositAddressResource } from './interfaces.js';

export class DepositAddressResource implements IDepositAddressResource {
  private readonly api: InflowApiClient;

  constructor(options: InflowOptions = {}, resolvedConfig?: ResolvedInflowSdkConfig) {
    const config: ResolvedInflowSdkConfig = resolvedConfig ?? resolveInflowSdkConfig(options);
    this.api = new InflowApiClient(config, config.apiBaseUrl);
  }

  async list(options: { signal?: AbortSignal } = {}): Promise<DepositAddresses> {
    const requestOptions = options.signal !== undefined ? { signal: options.signal } : {};
    const response = await this.api.get('/v1/deposit-addresses', requestOptions);
    const { status, data } = response;
    if (status < 200 || status >= 300) {
      throw createApiError(response, 'Failed to list deposit addresses');
    }
    const body = (data as Partial<DepositAddresses> | null) ?? {};
    return {
      configured: body.configured ?? [],
      unconfigured: body.unconfigured ?? [],
    };
  }
}
