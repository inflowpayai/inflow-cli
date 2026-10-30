import { z } from 'incur';
import { PAYMENT_FILTERS } from '../odp/payments.js';
import { directoryServiceOutput, operationOutput, paymentProtocolOutput, protocolsOutput } from '../odp/schema.js';

const namedProtocol = z.object({ name: z.string() });
const service = directoryServiceOutput
  .partial()
  .extend({
    service_id: z.string().describe('Directory Service identifier.'),
    service_origin: z.string().describe('Service origin.'),
    name: z.string().describe('Service name.'),
    indexed_at: z.string().describe('Indexing timestamp.'),
    source: z
      .object({ type: z.string(), url: z.string(), x402_discovery: z.boolean() })
      .meta({ additionalProperties: true })
      .describe('Source document metadata.'),
    protocols: protocolsOutput.optional(),
  })
  .meta({ additionalProperties: true });

export const directorySearchOutput = z
  .object({
    items: z
      .array(
        z.union([
          z
            .object({
              type: z.literal('service'),
              service,
              indexed_at: z.string(),
              publisher: z
                .object({ publisher_id: z.string(), name: z.string(), website_url: z.string() })
                .meta({ additionalProperties: true })
                .nullable()
                .optional(),
            })
            .meta({ additionalProperties: true }),
          z
            .object({
              type: z.literal('collection'),
              service,
              indexed_at: z.string(),
              collection: z
                .object({ id: z.string(), name: z.string(), description: z.string().optional() })
                .meta({ additionalProperties: true }),
            })
            .meta({ additionalProperties: true }),
          z
            .object({ type: z.literal('unknown'), resource_type: z.string(), raw: z.record(z.string(), z.unknown()) })
            .describe('Unsupported directory result type, retained without interpretation.'),
        ]),
      )
      .describe('Service, Collection, or unsupported results.'),
    next: z.string().optional().describe('Opaque continuation URL; pass as --next.'),
    issues: z
      .array(z.object({ index: z.number(), message: z.string() }))
      .optional()
      .describe('Rejected result positions in the original directory page.'),
    facets: z
      .object({
        keywords: z.array(z.object({ value: z.string(), count: z.number() })).optional(),
        enrollment: z.array(z.object({ value: namedProtocol, count: z.number() })).optional(),
        trust: z.array(z.object({ value: namedProtocol, count: z.number() })).optional(),
        payments: z.array(z.object({ value: paymentProtocolOutput, count: z.number() })).optional(),
        payment_options: z
          .array(z.object({ value: z.object({ name: z.string(), option: z.string() }), count: z.number() }))
          .optional(),
        operations: z.array(z.object({ value: operationOutput, count: z.number() })).optional(),
      })
      .optional()
      .describe('Available filters and matching result counts.'),
  })
  .meta({ additionalProperties: true });

export const directorySuggestOutput = z.object({
  items: z.array(z.string()).describe('Matching Service and Collection names; empty when no suggestions match.'),
});

const operation = z.enum([
  'get-collection',
  'get-offering',
  'list-collection-offerings',
  'list-collections',
  'list-offerings',
  'search-collections',
  'search-offerings',
]);

export const directorySearchArgs = z.object({
  query: z
    .string()
    .trim()
    .min(1, 'Enter nonblank search text.')
    .optional()
    .describe('Optional free-text Service and Collection query.'),
});

export const directorySearchOptions = z.object({
  keyword: z.array(z.string()).default([]).describe('Repeatable Service keyword filter.'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum directory results requested.'),
  next: z.string().optional().describe('Opaque continuation URL from an earlier directory response.'),
  operation: z.array(operation).default([]).describe('Filter by an advertised ODP operation. Repeatable.'),
  payment: z
    .array(z.enum(PAYMENT_FILTERS))
    .default([])
    .describe('Repeatable payment filter in protocol or protocol:option form.'),
  source: z
    .array(z.enum(['odp', 'openapi']))
    .default([])
    .describe('Repeatable source format filter; omitted for all formats.'),
  withAep: z.boolean().default(false).describe('Only include results whose Service advertises AEP.'),
});

export const directorySuggestArgs = z.object({
  prefix: z
    .string()
    .trim()
    .min(1, 'Enter nonblank suggestion text.')
    .describe('Text to match against Service and Collection metadata; returns matching names.'),
});

export const directorySuggestOptions = directorySearchOptions.omit({ next: true }).extend({
  limit: z.number().int().min(1).max(25).optional().describe('Maximum suggestions to return.'),
});
