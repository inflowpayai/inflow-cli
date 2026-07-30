import { type InflowOptions, type ResolvedInflowSdkConfig, resolveInflowSdkConfig } from '../config.js';
import type { User } from '../types/index.js';
import { InflowApiClient } from '../utils/api-client.js';
import { createApiError } from './api-error.js';
import type { IUserResource } from './interfaces.js';

export class UserResource implements IUserResource {
  private readonly api: InflowApiClient;

  constructor(options: InflowOptions = {}, resolvedConfig?: ResolvedInflowSdkConfig) {
    const config: ResolvedInflowSdkConfig = resolvedConfig ?? resolveInflowSdkConfig(options);
    this.api = new InflowApiClient(config, config.apiBaseUrl);
  }

  async retrieve(options: { signal?: AbortSignal } = {}): Promise<User> {
    const requestOptions = options.signal !== undefined ? { signal: options.signal } : {};
    const response = await this.api.get('/v1/users/self', requestOptions);
    const { status, data } = response;
    if (status < 200 || status >= 300) {
      throw createApiError(response, 'Failed to retrieve user');
    }
    return data as User;
  }
}
