import type { MppChallenge } from '@inflowpayai/mpp';
import type {
  AuthTokens,
  Balance,
  DepositAddresses,
  DeviceAuthRequest,
  PagedSubscriptions,
  Subscription,
  SubscriptionAuthorization,
  User,
} from '../types/index.js';

export interface IAuthResource {
  initiateDeviceAuth(clientName?: string): Promise<DeviceAuthRequest>;
  pollDeviceAuth(deviceCode: string): Promise<AuthTokens | null>;
  refreshToken(refreshToken: string): Promise<AuthTokens>;
  revokeToken(token: string): Promise<void>;
}

export interface IBalanceResource {
  list(options?: { signal?: AbortSignal }): Promise<Balance[]>;
}

export interface IDepositAddressResource {
  list(options?: { signal?: AbortSignal }): Promise<DepositAddresses>;
}

export interface SubscriptionListOptions {
  descending?: boolean;
  endDate?: string;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
  startDate?: string;
  status?: string;
}

export interface ISubscriptionResource {
  authorize(
    subscriptionId: string,
    challenge: MppChallenge,
    options?: { signal?: AbortSignal },
  ): Promise<SubscriptionAuthorization>;
  cancel(subscriptionId: string, options?: { signal?: AbortSignal }): Promise<void>;
  get(subscriptionId: string, options?: { signal?: AbortSignal }): Promise<Subscription>;
  list(options?: SubscriptionListOptions): Promise<PagedSubscriptions>;
}

export interface IUserResource {
  retrieve(options?: { signal?: AbortSignal }): Promise<User>;
}
