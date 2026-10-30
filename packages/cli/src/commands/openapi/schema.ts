import { z } from 'incur';
import { httpUrlArgument } from '../../utils/http-url-argument.js';

const strings = z.array(z.string());
const providerObject = z.record(z.string(), z.unknown());
const source = z.object({ type: z.literal('openapi'), url: z.string() });
const selector = z.object({ method: z.string(), path: z.string(), operationId: z.string().optional() });
const payment = z
  .object({
    advertised: z.boolean(),
    protocols: z.array(z.enum(['mpp', 'x402'])),
    offers: z.array(providerObject),
    response402: z.boolean(),
    notes: strings,
  })
  .describe('Advertised payment metadata; not proof that a live request requires payment.');
const requirements = z.array(z.record(z.string(), strings));
const request = z.object({
  method: z.string(),
  url: z.string(),
  headers: z.record(z.string(), z.string()),
  body: z.string().optional(),
});
const redactions = z.array(z.object({ location: z.enum(['header', 'query']), name: z.string() }));
const next = z
  .array(
    z.object({
      command: strings,
      url: z.string(),
      options: z.object({ method: z.string(), header: strings, data: z.string().optional() }),
      requiredInputs: redactions,
      message: z.string(),
    }),
  )
  .describe('Explicit follow-up commands; restore redacted inputs before use. A follow-up makes a new request.');

export const operationOutput = selector.extend({
  summary: z.string().optional().describe('Provider summary.'),
  description: z.string().optional().describe('Provider description.'),
  tags: strings.optional().describe('Provider tags.'),
  servers: z.array(providerObject).describe('Provider OpenAPI Server Objects, including variable definitions.'),
  parameters: z.array(providerObject).describe('Provider OpenAPI Parameter Objects with their JSON Schemas.'),
  requestBody: providerObject.optional().describe('Provider OpenAPI Request Body Object.'),
  security: requirements.describe('Alternative security requirements; all schemes within one object are required.'),
  securitySchemes: z.record(z.string(), providerObject).describe('Named provider OpenAPI Security Scheme Objects.'),
  limitations: strings.describe('Limitations found while reading the operation.'),
  payment: payment.optional(),
});
export const descriptionOutput = z
  .object({
    sourceUrl: z.string(),
    retrievalUrl: z.string(),
    version: z.string(),
    title: z.string(),
    description: z.string().optional(),
    operations: z.array(operationOutput),
    limitations: strings,
  })
  .describe('Parsed OpenAPI document and its operations.');
export const listOutput = z.object({
  source: source.describe('Source document.'),
  title: z.string().describe('Document title.'),
  openapi: z.string().describe('OpenAPI version.'),
  items: z
    .array(selector.extend({ summary: z.string().optional(), tags: strings.optional(), payment: payment.optional() }))
    .describe('Matching operations.'),
  limitations: strings.describe('Document interpretation limitations.'),
});
export const getOutput = z.object({
  source: source.describe('Source document.'),
  operation: operationOutput.describe('Selected operation.'),
  limitations: strings.describe('Document interpretation limitations.'),
});
const prepared = z.object({
  source: source.describe('Source document.'),
  operation: selector.describe('Selected operation.'),
  request: request.describe('Request preview with recognized credentials redacted.'),
  redactions: redactions.describe('Input locations whose original values must be supplied before calling.'),
});
export const prepareOutput = prepared.extend({
  outcome: z.literal('request-prepared').describe('No request was sent.'),
  authentication: z
    .object({ requirements, verified: z.boolean() })
    .describe('Declared authentication requirements; preparation does not verify credentials.'),
  limitations: strings.describe('Preparation and interpretation limitations.'),
  payment: payment.optional(),
  next,
});
export const callOutput = z
  .union([
    prepared
      .extend({
        outcome: z.literal('payment-required'),
        sent: z.literal(false),
        payment,
        next,
      })
      .describe('Advertised payment prevented invocation.'),
    prepared
      .extend({
        outcome: z.enum(['payment-required', 'authentication-required', 'response', 'http-error']),
        sent: z.literal(true),
        status: z.number().describe('HTTP response status.'),
        content_type: z.string().nullable().describe('Response Content-Type, or null if absent.'),
        response_size_bytes: z.number().describe('Response body size.'),
        body: z.string().optional().describe('Inline text response.'),
        body_base64: z.string().optional().describe('Inline binary response encoded as base64.'),
        output_saved_to: z.string().optional().describe('Path containing the response bytes.'),
        payment: z
          .object({ protocols: z.array(z.enum(['mpp', 'x402'])) })
          .optional()
          .describe('Recognized protocols in a live HTTP 402 response.'),
        next,
      })
      .describe('One request was sent; no enrollment or payment was performed.'),
  ])
  .meta({ type: 'object' });

export const documentArgs = z.object({
  source: httpUrlArgument.describe('HTTPS origin or exact public OpenAPI JSON document URL.'),
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
