import { z } from 'incur';

export const inspectArgs = z.object({
  url: z
    .string()
    .describe(
      'An origin or recognized ODP/OpenAPI document URL for public discovery, or an endpoint URL to probe. No enrollment or payment is performed.',
    ),
});

export const inspectOptions = z.object({
  method: z.string().optional().describe('Explicitly probe using this HTTP method. Endpoint probes default to GET.'),
  refresh: z.boolean().default(false).describe('Revalidate public documents and rediscover origin candidates.'),
  data: z
    .string()
    .optional()
    .describe(
      'Request body for the probe. JSON or raw text. Content-Type defaults to application/json when --data is set unless a --header overrides it.',
    ),
  header: z.array(z.string()).default([]).describe('Repeatable. "Name: Value" format.'),
});
