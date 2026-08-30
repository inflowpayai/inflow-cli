import { InflowApiError } from '../errors.js';
import type { CliCapabilities, ICliCapabilitiesResource } from './interfaces.js';
import type { InflowApiClient } from '../utils/api-client.js';
import { createApiError } from './api-error.js';

const DISABLED_CAPABILITIES: CliCapabilities = Object.freeze({
  features: Object.freeze([]),
  minimumSupportedVersion: '',
});

export class CliCapabilitiesResource implements ICliCapabilitiesResource {
  private cached: { expires: number; value: CliCapabilities } | undefined;
  private pending: Promise<CliCapabilities> | undefined;

  constructor(
    private readonly api: InflowApiClient,
    private readonly maxAgeMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(options: { signal?: AbortSignal } = {}): Promise<CliCapabilities> {
    if (this.cached !== undefined && this.now() < this.cached.expires) return Promise.resolve(this.cached.value);
    if (this.pending !== undefined) return this.pending;

    this.pending = this.fetch(options.signal).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  async has(feature: string, options: { signal?: AbortSignal } = {}): Promise<boolean> {
    const capabilities = await this.get(options);
    return capabilities.features.includes(feature);
  }

  private async fetch(signal: AbortSignal | undefined): Promise<CliCapabilities> {
    try {
      const response = await this.api.get('/v1/cli/capabilities', {
        ...(signal === undefined ? {} : { signal }),
        retries: 1,
        skipAuth: true,
        timeoutMs: 3_000,
      });
      if (response.status < 200 || response.status >= 300) {
        throw createApiError(response, 'Failed to retrieve CLI capabilities');
      }
      const value = parseCapabilities(response.data);
      this.cached = { expires: this.expiry(), value };
      return value;
    } catch (error) {
      if (error instanceof InflowApiError && error.status === 426) throw error;
      this.cached = { expires: this.expiry(), value: DISABLED_CAPABILITIES };
      return DISABLED_CAPABILITIES;
    }
  }

  private expiry(): number {
    return this.maxAgeMs === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : this.now() + this.maxAgeMs;
  }
}

function parseCapabilities(value: unknown): CliCapabilities {
  if (value === null || typeof value !== 'object') return DISABLED_CAPABILITIES;
  const candidate = value as { features?: unknown; minimumSupportedVersion?: unknown };
  if (!Array.isArray(candidate.features) || typeof candidate.minimumSupportedVersion !== 'string') {
    return DISABLED_CAPABILITIES;
  }
  const features = candidate.features.filter((feature): feature is string => typeof feature === 'string');
  return Object.freeze({
    features: Object.freeze(features),
    minimumSupportedVersion: candidate.minimumSupportedVersion,
  });
}
