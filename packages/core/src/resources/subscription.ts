import { type InflowOptions, type ResolvedInflowSdkConfig, resolveInflowSdkConfig } from '../config.js';
import type { MppChallenge, MppProblemDetail } from '@inflowpayai/mpp';
import { InflowApiError } from '../errors.js';
import type { PagedSubscriptions, Subscription, SubscriptionAuthorization } from '../types/index.js';
import { InflowApiClient } from '../utils/api-client.js';
import { normalizeDecimalString } from '../utils/decimal.js';
import { createApiError } from './api-error.js';
import type { ISubscriptionResource, SubscriptionListOptions } from './interfaces.js';

export class SubscriptionResource implements ISubscriptionResource {
  private readonly api: InflowApiClient;

  constructor(options: InflowOptions = {}, resolvedConfig?: ResolvedInflowSdkConfig) {
    const config = resolvedConfig ?? resolveInflowSdkConfig(options);
    this.api = new InflowApiClient(config, config.apiBaseUrl);
  }

  async authorize(
    subscriptionId: string,
    challenge: MppChallenge,
    options: { signal?: AbortSignal } = {},
  ): Promise<SubscriptionAuthorization> {
    const requestOptions = options.signal === undefined ? {} : { signal: options.signal };
    const response = await this.api.post(
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/authorize`,
      { challenge },
      requestOptions,
    );
    if (response.status < 200 || response.status >= 300) {
      throw createApiError(response, 'Failed to authorize subscription');
    }
    const body = response.data as { credential?: unknown; expires?: unknown; problem?: MppProblemDetail };
    if (body.problem !== undefined) {
      throw new InflowApiError(body.problem.detail, { status: body.problem.status, details: body.problem });
    }
    if (typeof body.credential !== 'string' || typeof body.expires !== 'string') {
      throw new InflowApiError('Subscription authorization response is missing its credential or expiry.', {
        status: response.status,
        details: response.data,
      });
    }
    return { credential: body.credential, expires: body.expires };
  }

  async cancel(subscriptionId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    const requestOptions = options.signal === undefined ? {} : { signal: options.signal };
    const response = await this.api.request(
      'DELETE',
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}/delete`,
      undefined,
      requestOptions,
    );
    if (response.status < 200 || response.status >= 300) {
      throw createApiError(response, 'Failed to cancel subscription');
    }
  }

  async get(subscriptionId: string, options: { signal?: AbortSignal } = {}): Promise<Subscription> {
    const requestOptions = options.signal === undefined ? {} : { signal: options.signal };
    const response = await this.api.get(`/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, requestOptions);
    if (response.status < 200 || response.status >= 300) {
      throw createApiError(response, 'Failed to get subscription');
    }
    return normalizeSubscription(response.data as Subscription);
  }

  async list(options: SubscriptionListOptions = {}): Promise<PagedSubscriptions> {
    const query = new URLSearchParams();
    if (options.offset !== undefined) query.set('offset', String(options.offset));
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.descending !== undefined) query.set('descending', String(options.descending));
    if (options.startDate !== undefined) query.set('startDate', options.startDate);
    if (options.endDate !== undefined) query.set('endDate', options.endDate);
    if (options.status !== undefined) query.set('status', options.status);
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    const requestOptions = options.signal === undefined ? {} : { signal: options.signal };
    const response = await this.api.get(`/v1/subscriptions${suffix}`, requestOptions);
    if (response.status < 200 || response.status >= 300) {
      throw createApiError(response, 'Failed to list subscriptions');
    }
    const body = response.data as PagedSubscriptions;
    return { ...body, data: body.data.map(normalizeSubscription) };
  }
}

function normalizeSubscription(subscription: Subscription): Subscription {
  return {
    ...subscription,
    amount: normalizeDecimalString(subscription.amount),
    period0Amount: normalizeDecimalString(subscription.period0Amount),
  };
}
