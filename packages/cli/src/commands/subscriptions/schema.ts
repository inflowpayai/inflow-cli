import { z } from 'incur';

export const subscriptionIdArgs = z.object({
  subscriptionId: z.string().describe('The subscription UUID.'),
});

export const subscriptionFetchArgs = subscriptionIdArgs.extend({
  resourceUrl: z.string().describe('The MPP-protected resource URL to fetch.'),
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
    .refine((value) => ['active', 'cancelled', 'expired', 'failed', 'past_due', 'pending', 'revoked'].includes(value), {
      message: 'Status must be active, cancelled, expired, failed, past_due, pending, or revoked.',
    })
    .optional()
    .describe(
      'Only include subscriptions with status active, cancelled, expired, failed, past_due, pending, or revoked.',
    ),
});
