export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  expires_at?: number;
}

export interface DeviceAuthRequest {
  device_code: string;
  user_code: string;
  verification_url: string;
  verification_url_complete: string;
  expires_in: number;
  interval: number;
}

export interface User {
  userId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  mobile: string | null;
  locale: string;
  timezone: string;
  created: string;
  updated: string;
}

export interface Balance {
  available: string;
  currency: string;
}

export interface ConfiguredDepositAddress {
  address: string;
  blockchain: string;
  currencies: string[];
}

export interface UnconfiguredDepositAddress {
  blockchain: string;
  currencies: string[];
}

export interface DepositAddresses {
  configured: ConfiguredDepositAddress[];
  unconfigured: UnconfiguredDepositAddress[];
}

export type SubscriptionStatus = 'ACTIVE' | 'CANCELLED' | 'EXPIRED' | 'FAILED' | 'PAST_DUE' | 'PENDING' | 'REVOKED';

export type SubscriptionPeriod = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';

export interface Subscription {
  amount: string;
  billingAnchor: string;
  buyerId?: string;
  cancelled?: string;
  created: string;
  currency: string;
  externalId?: string;
  failed?: string;
  lastChargedPeriod: number;
  nextBillingDate?: string;
  pastDue?: string;
  periodCount: number;
  period0Amount: string;
  periodUnit: SubscriptionPeriod;
  sellerId?: string;
  sellerName?: string;
  sellerWebsite?: string;
  status: SubscriptionStatus;
  subscriptionExpires: string;
  subscriptionId: string;
  transactionType: string;
  updated: string;
}

export interface PagedSubscriptions {
  count: number;
  data: Subscription[];
  total: number;
}

export interface SubscriptionAuthorization {
  credential: string;
  expires: string;
}
