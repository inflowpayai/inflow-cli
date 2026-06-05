import { z } from 'incur';

export const inspectArgs = z.object({
  url: z.string().describe('The resource URL to probe for MPP and/or x402 payment challenges. No payment is made.'),
});

export const inspectOptions = z.object({
  method: z.string().default('GET').describe('HTTP method for the probe request.'),
  data: z
    .string()
    .optional()
    .describe(
      'Request body for the probe. JSON or raw text. Content-Type defaults to application/json when --data is set unless a --header overrides it.',
    ),
  header: z.array(z.string()).default([]).describe('Repeatable. "Name: Value" format.'),
});
