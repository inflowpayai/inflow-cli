import { z } from 'incur';
import { PAYMENT_FILTERS } from '../odp/payments.js';

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
