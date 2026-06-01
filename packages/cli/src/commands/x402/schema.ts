import { z } from 'incur';

export const payArgs = z.object({
  url: z.string().describe('The x402-protected resource URL to pay for.'),
});

export const payOptions = z.object({
  scheme: z
    .string()
    .optional()
    .describe('Only consider `accepts[]` entries with this scheme (e.g. "exact", "balance").'),
  network: z.string().optional().describe('Only consider entries on this network (e.g. "eip155:84532").'),
  asset: z
    .string()
    .optional()
    .describe('Only consider entries with this on-chain asset id (ERC-20 address or SVM mint).'),
  assetName: z
    .string()
    .optional()
    .describe('Only consider entries whose `extra.assetName` symbol matches (e.g. "USDC").'),
  method: z.string().default('GET').describe('HTTP method for the seller request.'),
  data: z
    .string()
    .optional()
    .describe(
      'Request body. JSON or raw text. Content-Type defaults to application/json when --data is set unless a --header overrides it.',
    ),
  header: z.array(z.string()).default([]).describe('Repeatable. "Name: Value" format.'),
  interval: z.coerce
    .number()
    .default(0)
    .describe(
      'Inline poll cadence in seconds while awaiting approval. 0 returns the approval URL and a follow-up command hint without blocking.',
    ),
  maxAttempts: z.coerce
    .number()
    .default(0)
    .describe('Hard cap on poll attempts when --interval > 0. 0 means unlimited.'),
  timeout: z.coerce.number().default(900).describe('Polling deadline in seconds. Default 900s (matches x402-buyer).'),
  paymentId: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional()
    .describe(
      'Caller-supplied payment identifier. 16-128 chars, ^[a-zA-Z0-9_-]+$. Forwarded to the server as remotePaymentId.',
    ),
  showBody: z
    .boolean()
    .default(true)
    .describe(
      'Include the seller response body in the result. Default true so AI assistants paying for content receive the deliverable. Pass --no-show-body to suppress (e.g. for binary downloads paired with --output-file).',
    ),
  outputFile: z
    .string()
    .optional()
    .describe(
      'Write the seller response body bytes to this file path (overwrites silently). When set, the result frame includes `output_saved_to: <absolute_path>` instead of `body` / `body_base64`. Natural choice for binary content (PDFs, images, downloads).',
    ),
  payloadFile: z
    .string()
    .optional()
    .describe(
      'Write the signed `encoded_payload` bytes to this file path (mode 0o600, overwrites silently). When set, the result frame includes `payload_saved_to: <absolute_path>` instead of `encoded_payload`. Use to keep one-time payment credentials out of chat transcripts and logs.',
    ),
});

export const statusArgs = z.object({
  transactionId: z.string().describe('The transaction id returned by `x402 pay`.'),
});

export const statusOptions = z.object({
  interval: z.coerce
    .number()
    .default(0)
    .describe(
      'Poll cadence in seconds. 0 returns the current snapshot; positive values yield on every change until signed or terminal.',
    ),
  maxAttempts: z.coerce.number().default(0).describe('Hard cap on poll attempts. 0 means unlimited.'),
  timeout: z.coerce.number().default(900).describe('Polling deadline in seconds.'),
  payloadFile: z
    .string()
    .optional()
    .describe(
      'Write the signed `encoded_payload` bytes to this file path (mode 0o600, overwrites silently). When set, status frames include `payload_saved_to: <absolute_path>` instead of `encoded_payload`. Use to keep one-time payment credentials out of chat transcripts and logs.',
    ),
});

export const cancelArgs = z.object({
  approvalId: z.string().describe('The approval id returned by `x402 pay`.'),
});

export const decodeArgs = z.object({
  header: z.string().describe('Raw PAYMENT-REQUIRED header value (base64).'),
});

export const inspectArgs = z.object({
  url: z.string().describe('The x402-protected resource URL to probe. No payment is made.'),
});

export const inspectOptions = z.object({
  scheme: z.string().optional().describe('Only show `accepts[]` entries with this scheme (e.g. "exact", "balance").'),
  network: z.string().optional().describe('Only show entries on this network (e.g. "eip155:84532").'),
  asset: z.string().optional().describe('Only show entries with this on-chain asset id (ERC-20 address or SVM mint).'),
  assetName: z.string().optional().describe('Only show entries whose `extra.assetName` symbol matches (e.g. "USDC").'),
  method: z.string().default('GET').describe('HTTP method for the probe request.'),
  data: z
    .string()
    .optional()
    .describe(
      'Request body for the probe. JSON or raw text. Content-Type defaults to application/json when --data is set unless a --header overrides it.',
    ),
  header: z.array(z.string()).default([]).describe('Repeatable. "Name: Value" format.'),
});
