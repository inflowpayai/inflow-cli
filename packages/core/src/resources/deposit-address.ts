import { type InflowOptions, type ResolvedInflowSdkConfig, resolveInflowSdkConfig } from '../config.js';
import { InflowApiError } from '../errors.js';
import type { DepositAddresses } from '../types/index.js';
import { InflowApiClient } from '../utils/api-client.js';
import { redactRawBody } from '../utils/redact.js';
import type { IDepositAddressResource } from './interfaces.js';

export class DepositAddressResource implements IDepositAddressResource {
  private readonly api: InflowApiClient;

  constructor(options: InflowOptions = {}, resolvedConfig?: ResolvedInflowSdkConfig) {
    const config: ResolvedInflowSdkConfig = resolvedConfig ?? resolveInflowSdkConfig(options);
    this.api = new InflowApiClient(config, config.apiBaseUrl);
  }

  async list(options: { signal?: AbortSignal } = {}): Promise<DepositAddresses> {
    const requestOptions = options.signal !== undefined ? { signal: options.signal } : {};
    const { status, data, rawBody } = await this.api.get('/v1/deposit-addresses', requestOptions);
    if (status < 200 || status >= 300) {
      throw new InflowApiError(
        `Failed to list deposit addresses (${String(status)}): ${redactRawBody(rawBody) || 'unknown error'}`,
        {
          status,
          rawBody,
          details: data,
        },
      );
    }
    const body = (data as Partial<DepositAddresses> | null) ?? {};
    return {
      configured: body.configured ?? [],
      unconfigured: body.unconfigured ?? [],
    };
  }
}
