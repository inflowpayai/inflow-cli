import { z } from 'incur';

export const payArgs = z.object({
  url: z.string().describe('The MPP-protected resource URL to pay for.'),
});

export const payOptions = z.object({
  paymentMethod: z.string().optional().describe('Only consider challenges with this payment method (e.g. "inflow").'),
  intent: z.string().optional().describe('Only consider challenges with this intent (e.g. "charge").'),
  currency: z.string().optional().describe('Only consider challenges in this currency (e.g. "USDC").'),
  rail: z
    .string()
    .optional()
    .describe('Only consider challenges on this settlement rail (e.g. "balance", "instrument").'),
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
      'Inline poll cadence in seconds while a transaction is pending. 0 returns the transaction id and a follow-up command hint without blocking.',
    ),
  maxAttempts: z.coerce
    .number()
    .default(0)
    .describe('Hard cap on poll attempts when --interval > 0. 0 means unlimited.'),
  timeout: z.coerce
    .number()
    .default(900)
    .describe('Polling deadline in seconds. Default 900s (matches the server-side approval expiry).'),
  instrumentId: z
    .string()
    .optional()
    .describe(
      'Funding instrument id (UUID) for an instrument-rail challenge. The buyer does not choose the rail — it is derived from the seller challenge; this is the only buyer-supplied payment option.',
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
  credentialFile: z
    .string()
    .optional()
    .describe(
      'Write the base64url `Authorization: Payment` credential to this file path (mode 0o600, overwrites silently). When set, the result frame includes `credential_saved_to: <absolute_path>` instead of `credential`. Use to keep one-time payment credentials out of chat transcripts and logs.',
    ),
});

export const statusArgs = z.object({
  transactionId: z.string().describe('The transaction id returned by `mpp pay`.'),
});

export const statusOptions = z.object({
  interval: z.coerce
    .number()
    .default(0)
    .describe(
      'Poll cadence in seconds. 0 returns the current snapshot; positive values yield on every change until ready or terminal.',
    ),
  maxAttempts: z.coerce.number().default(0).describe('Hard cap on poll attempts. 0 means unlimited.'),
  timeout: z.coerce.number().default(900).describe('Polling deadline in seconds.'),
  credentialFile: z
    .string()
    .optional()
    .describe(
      'Write the base64url `Authorization: Payment` credential to this file path (mode 0o600, overwrites silently). When set, the ready frame includes `credential_saved_to: <absolute_path>` instead of `credential`. Use to keep one-time payment credentials out of chat transcripts and logs.',
    ),
});

export const cancelArgs = z.object({
  approvalId: z.string().describe('The approval id returned by `mpp pay` (on the pending frame).'),
});

export const decodeArgs = z.object({
  value: z
    .string()
    .describe(
      'A raw `WWW-Authenticate: Payment` header value, or a base64url `Authorization: Payment` credential / `Payment-Receipt`. The kind is auto-detected.',
    ),
});

export const inspectArgs = z.object({
  url: z.string().describe('The MPP-protected resource URL to probe. No payment is made.'),
});

export const inspectOptions = z.object({
  paymentMethod: z.string().optional().describe('Only show challenges with this payment method (e.g. "inflow").'),
  intent: z.string().optional().describe('Only show challenges with this intent (e.g. "charge").'),
  currency: z.string().optional().describe('Only show challenges in this currency (e.g. "USDC").'),
  rail: z.string().optional().describe('Only show challenges on this settlement rail (e.g. "balance", "instrument").'),
  method: z.string().default('GET').describe('HTTP method for the probe request.'),
  data: z
    .string()
    .optional()
    .describe(
      'Request body for the probe. JSON or raw text. Content-Type defaults to application/json when --data is set unless a --header overrides it.',
    ),
  header: z.array(z.string()).default([]).describe('Repeatable. "Name: Value" format.'),
});
