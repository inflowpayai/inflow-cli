import { z } from 'incur';

export const documentArgs = z.object({
  source: z.string().describe('HTTPS origin or exact public OpenAPI JSON document URL.'),
});

const documentOptions = z.object({
  refresh: z.boolean().default(false).describe('Revalidate documents and rediscover locations for an origin.'),
});

export const listOptions = documentOptions.extend({
  collectionId: z
    .string()
    .regex(/^(?!\.{1,2}$)[A-Za-z0-9._~-]{1,128}$/)
    .optional()
    .describe('Directory Collection identifier. Selects its operations from the provider document.'),
  tag: z
    .string()
    .min(1)
    .optional()
    .describe('Exact provider operation tag. Combines with --collection-id by intersection.'),
});

export const getOptions = documentOptions.extend({
  method: z.string().optional().describe('HTTP method, together with --path.'),
  operationId: z.string().optional().describe('Unique operationId, instead of --method and --path.'),
  path: z.string().optional().describe('Exact documented path template, together with --method.'),
});

export const prepareOptions = getOptions.extend({
  data: z
    .string()
    .optional()
    .describe('JSON request body. Included in the preview; arbitrary sensitive fields are not redacted.'),
  header: z
    .array(z.string())
    .default([])
    .describe('Repeatable "Name: Value" request header. Recognized credentials are redacted in output.'),
  parameters: z
    .string()
    .optional()
    .describe('JSON object with path, query, and header objects containing declared parameter values.'),
  server: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('One-based advertised server number; required when multiple servers exist.'),
  serverVariables: z
    .string()
    .optional()
    .describe('JSON object overriding declared server variables; otherwise their declared defaults are used.'),
});

export const callOptions = prepareOptions.extend({
  timeout: z
    .number()
    .positive()
    .max(900)
    .default(30)
    .describe('Request timeout in seconds. A timeout does not prove the operation failed.'),
  maxResponseBytes: z
    .number()
    .int()
    .positive()
    .max(16777216)
    .default(16777216)
    .describe('Maximum response size in bytes, up to 16 MiB.'),
  showBody: z.boolean().default(true).describe('Include the response body in output.'),
  outputFile: z.string().min(1).optional().describe('Save response bytes to this path, overwriting an existing file.'),
});
