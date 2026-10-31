import { z } from 'incur';
import { httpUrlArgument } from '../../utils/http-url-argument.js';

const statuses = ['active', 'cancelled', 'expired', 'failed', 'past_due', 'pending', 'revoked'];
const statusPattern = `^(?:${statuses.map((status) => status.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`)).join('|')})$`;

export const subscriptionOutput = z
  .object({
    amount: z.string().describe('Recurring price as an exact decimal string in currency units.'),
    billingAnchor: z.string().describe('RFC 3339 timestamp anchoring the billing periods.'),
    buyerId: z.string().optional().describe('InFlow buyer account identifier, when available.'),
    cancelled: z.string().optional().describe('RFC 3339 timestamp of buyer cancellation.'),
    created: z.string().describe('RFC 3339 creation timestamp.'),
    currency: z.string().describe('Currency of the recurring and initial prices.'),
    externalId: z.string().optional().describe('Seller-provided subscription reference.'),
    failed: z.string().optional().describe('RFC 3339 timestamp of terminal failure.'),
    lastChargedPeriod: z.number().describe('Index of the latest successfully settled billing period.'),
    nextBillingDate: z.string().optional().describe('RFC 3339 timestamp of the next scheduled collection attempt.'),
    pastDue: z.string().optional().describe('RFC 3339 timestamp when the current past-due period began.'),
    period0Amount: z.string().describe('Initial-period price as an exact decimal string in currency units.'),
    periodCount: z.number().describe('Number of periodUnit units in each billing period.'),
    periodUnit: z.string().describe('Billing period unit, such as hour, day, week, month, quarter, or year.'),
    revoked: z.string().optional().describe('RFC 3339 timestamp of seller revocation.'),
    sellerId: z.string().optional().describe('InFlow seller account identifier, when available.'),
    sellerName: z.string().optional().describe('Seller display name.'),
    sellerWebsite: z.string().optional().describe('Seller website URL, including any path supplied by the seller.'),
    status: z.string().describe('Lifecycle status: ACTIVE, CANCELLED, EXPIRED, FAILED, PAST_DUE, PENDING, or REVOKED.'),
    subscriptionExpires: z
      .string()
      .describe('RFC 3339 timestamp of the absolute subscription end, not a renewal date.'),
    subscriptionId: z.string().describe('Subscription identifier for get, cancel, and fetch commands.'),
    transactionType: z.string().describe('Transaction protocol that activated the subscription.'),
    updated: z.string().describe('RFC 3339 timestamp of the latest update.'),
  })
  .meta({ additionalProperties: true });

export const listOutput = z
  .object({
    count: z.number().describe('Number of subscriptions in this page.'),
    data: z.array(subscriptionOutput).describe('Subscriptions in this page; empty when none match.'),
    total: z.number().describe('Total subscriptions matching the filters, before pagination.'),
  })
  .meta({ additionalProperties: true });

export const cancelOutput = z.object({
  cancelled: z.literal(true).describe('The cancellation request completed successfully.'),
  subscription_id: z.string().describe('Identifier of the subscription targeted by the cancellation request.'),
});

export const subscriptionIdArgs = z.object({
  subscriptionId: z.string().describe('The subscription UUID.'),
});

export const subscriptionFetchArgs = subscriptionIdArgs.extend({
  resourceUrl: httpUrlArgument.describe('The MPP-protected resource URL to fetch.'),
});

export const listOptions = z.object({
  offset: z.coerce.number().int().min(0).default(0).describe('Number of subscriptions to skip.'),
  limit: z.coerce.number().int().min(0).max(100).default(10).describe('Maximum subscriptions to return.'),
  descending: z.boolean().default(true).describe('Sort newest first.'),
  startDate: z.string().optional().describe('Include subscriptions created on or after this RFC 3339 timestamp.'),
  endDate: z.string().optional().describe('Include subscriptions created on or before this RFC 3339 timestamp.'),
  status: z
    .string()
    .toLowerCase()
    .refine((value) => statuses.includes(value), {
      message: 'Status must be active, cancelled, expired, failed, past_due, pending, or revoked.',
    })
    .optional()
    .describe(
      'Only include subscriptions with status active, cancelled, expired, failed, past_due, pending, or revoked.',
    )
    .meta({ pattern: statusPattern }),
});
