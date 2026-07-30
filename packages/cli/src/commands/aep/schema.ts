import { z } from 'incur';

export const serviceReferenceArgs = z.object({
  serviceReference: z.string().describe('AEP Service URL, host, protected resource URL, or did:web Service reference.'),
});

export const fetchArgs = z.object({
  resourceUrl: z.string().describe('The AEP-protected resource URL to fetch.'),
});

export const fetchOptions = z.object({
  credentialId: z.string().optional().describe('Use this stored credential identifier.'),
  grantType: z.string().optional().describe('Use or request this advertised session credential type.'),
  method: z.string().default('GET').describe('HTTP method for the resource request.'),
  data: z.string().optional().describe('Replayable JSON or text request body.'),
  header: z.array(z.string()).default([]).describe('Repeatable request header in "Name: Value" format.'),
  interval: z.coerce.number().optional().describe('Approval polling cadence in seconds.'),
  timeout: z.coerce.number().default(900).describe('Total request and approval deadline in seconds.'),
  maxRedirects: z.coerce.number().default(5).describe('Maximum redirect count.'),
  maxResponseBytes: z.coerce.number().default(16_777_216).describe('Maximum response body size in bytes.'),
  showBody: z.boolean().default(true).describe('Include a text or base64 response body in structured output.'),
  outputFile: z.string().optional().describe('Write response bytes to this path instead of returning them inline.'),
});

export const inspectOptions = z.object({
  method: z.string().default('GET').describe('HTTP method for the exact resource probe.'),
  data: z.string().optional().describe('Replayable JSON or text body for the exact resource probe.'),
  header: z.array(z.string()).default([]).describe('Repeatable probe header in "Name: Value" format.'),
  timeout: z.coerce.number().default(30).describe('Total Inspect deadline in seconds. Maximum 300 seconds.'),
});

export const enrollOptions = z.object({
  interval: z.coerce
    .number()
    .optional()
    .describe('Approval polling cadence in seconds. Must be positive when supplied.'),
  maxAttempts: z.coerce.number().default(0).describe('Maximum approval poll attempts. 0 means unlimited.'),
  timeout: z.coerce.number().default(900).describe('Approval polling deadline in seconds. Maximum 900 seconds.'),
});

export const grantOptions = z.object({
  grantType: z
    .string()
    .optional()
    .describe('Session credential type. Defaults to the first advertised type shown in Inspect output.'),
  scope: z.array(z.string()).default([]).describe('Repeatable requested scope.'),
  interval: z.coerce
    .number()
    .optional()
    .describe('Approval polling cadence in seconds. Must be positive when supplied.'),
  timeout: z.coerce.number().default(900).describe('Approval polling deadline in seconds. Maximum 900 seconds.'),
});

export const revokeOptions = z.object({
  credentialId: z.string().optional().describe('Revoke one credential by identifier.'),
  grantType: z.string().optional().describe('Revoke credentials for one advertised grant type.'),
});
