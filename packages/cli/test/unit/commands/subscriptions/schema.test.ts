import { describe, expect, it } from 'vitest';
import { Schema } from 'incur';
import {
  listOptions,
  subscriptionFetchArgs,
  subscriptionIdArgs,
  subscriptionOutput,
} from '../../../../src/commands/subscriptions/schema.js';

describe('subscription command schemas', () => {
  it('describes optional metadata, exact prices, and additive server fields', () => {
    const schema = Schema.toJsonSchema(subscriptionOutput) as {
      additionalProperties?: boolean;
      properties?: Record<string, { type?: string; description?: string }>;
      required?: string[];
    };
    expect(schema.additionalProperties).toBe(true);
    expect(schema.properties?.['amount']?.type).toBe('string');
    expect(schema.properties?.['period0Amount']?.type).toBe('string');
    expect(schema.required).not.toContain('revoked');
    expect(schema.required).not.toContain('sellerId');
    expect(schema.required).not.toContain('nextBillingDate');
    for (const property of Object.values(schema.properties ?? {})) expect(property.description).toBeTruthy();
  });
  it('applies bounded paging defaults', () => {
    expect(listOptions.parse({})).toEqual({ descending: true, limit: 10, offset: 0 });
    expect(() => listOptions.parse({ limit: 101 })).toThrow();
    expect(() => listOptions.parse({ offset: -1 })).toThrow();
  });

  it('accepts a status filter and rejects unknown statuses', () => {
    expect(listOptions.parse({ status: 'ACTIVE' }).status).toBe('active');
    expect(listOptions.parse({ status: 'PAST_DUE' }).status).toBe('past_due');
    expect(listOptions.parse({ status: 'expired' }).status).toBe('expired');
    expect(listOptions.parse({ status: 'revoked' }).status).toBe('revoked');
    expect(listOptions.safeParse({ status: 'UNKNOWN' }).success).toBe(false);
  });

  it('requires the subscription identifier', () => {
    expect(subscriptionIdArgs.parse({ subscriptionId: 'id' })).toEqual({ subscriptionId: 'id' });
    expect(() => subscriptionIdArgs.parse({})).toThrow();
  });

  it('requires a subscription and resource URL for fetch', () => {
    expect(subscriptionFetchArgs.parse({ subscriptionId: 'id', resourceUrl: 'https://seller/resource' })).toEqual({
      subscriptionId: 'id',
      resourceUrl: 'https://seller/resource',
    });
  });
});
