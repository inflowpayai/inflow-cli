import { z } from 'incur';
import { httpUrlArgument } from '../../utils/http-url-argument.js';
import { inspectDocument, openApiPolicyOutput } from '../aep/schema.js';
import { serviceDocumentOutput } from '../odp/schema.js';
import { descriptionOutput } from '../openapi/schema.js';

const error = z.object({ code: z.string(), message: z.string() });
const source = z.union([
  z.object({ sourceType: z.literal('odp'), sourceUrl: z.string(), document: serviceDocumentOutput }),
  z.object({ sourceType: z.literal('openapi'), sourceUrl: z.string(), document: descriptionOutput }),
]);
const common = z.object({
  url: z.string().describe('Requested resource URL.'),
  method: z.string().describe('Probe method.'),
  status: z.number().optional().describe('Probe HTTP status when available.'),
  detected: z.array(z.string()).describe('Protocols detected in discovery documents or the response.'),
  odp: z
    .object({
      available: z.boolean(),
      inspect: z.object({ document: serviceDocumentOutput, service_origin: z.string() }).optional(),
      error: error.optional(),
    })
    .describe('ODP discovery availability and details.'),
  aep: z
    .object({
      required: z.boolean(),
      source: z.string(),
      blocked: z.boolean().optional(),
      message: z.string().optional(),
      challenge: z.object({ reason: z.string() }).optional(),
      openapi: openApiPolicyOutput.optional(),
      inspect: z.object({ document: inspectDocument, service_url: z.string() }).optional(),
      error: error.optional(),
    })
    .describe('AEP discovery and authentication assessment; errors do not imply public access.'),
  warnings: z
    .array(error.extend({ protocol: z.string(), methods: z.array(z.string()).optional() }))
    .optional()
    .describe('Partial inspection problems.'),
  discovery: z
    .union([z.object({ source }), z.object({ error })])
    .optional()
    .describe('Origin-level public document discovery.'),
});

export const inspectOutput: z.ZodType<Record<string, unknown> | undefined> = z
  .union([
    z
      .object({
        outcome: z.literal('document-inspected'),
        source: z.object({ type: z.literal('odp'), url: z.string() }),
        service_origin: z.string(),
        document: serviceDocumentOutput,
      })
      .describe('Public ODP document inspection; no resource operation was invoked.'),
    z
      .object({
        outcome: z.literal('document-inspected'),
        source: z.object({ type: z.literal('openapi'), url: z.string() }),
        operation_count: z.number(),
        document: descriptionOutput,
      })
      .describe('Public OpenAPI document inspection; no resource operation was invoked.'),
    common.extend({
      outcome: z.literal('no-payment-required'),
      status: z.number(),
      body_size_bytes: z.number().describe('Probe response body size.'),
      content_type: z.string().optional().describe('Probe response Content-Type.'),
    }),
    common.extend({
      outcome: z.literal('inspected'),
      mpp: z
        .array(
          z.object({
            id: z.string(),
            realm: z.string(),
            method: z.string(),
            intent: z.string(),
            amount: z.string().optional(),
            currency: z.string().optional(),
            recipient: z.string().optional(),
            rail: z.string().optional(),
            instrument_id: z.string().optional(),
            expires: z.string().optional(),
            description: z.string().optional(),
            digest: z.string().optional(),
            period_count: z.number().optional(),
            period_unit: z.string().optional(),
            subscription_expires: z.string().optional(),
            external_id: z.string().optional(),
            option_id: z.string().optional(),
            option_fingerprint: z.string().optional(),
          }),
        )
        .describe('Decoded MPP challenges; empty when none are available. Amounts are strings.'),
      x402: z
        .array(
          z.object({
            scheme: z.string(),
            network: z.string(),
            amount: z.string(),
            asset: z.string(),
            pay_to: z.string(),
            max_timeout_seconds: z.number(),
            extra: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .describe('Decoded x402 payment options; amounts are exact base-unit strings.'),
      x402_resource: z.string().optional().describe('x402 protected resource URL.'),
      x402_version: z.number().optional().describe('x402 protocol version.'),
      x402_extensions: z.record(z.string(), z.unknown()).optional().describe('Provider x402 extensions.'),
    }),
  ])
  .optional()
  .meta({ type: 'object' });

export const inspectArgs = z.object({
  url: httpUrlArgument.describe(
    'A resource URL to inspect for ODP, AEP, MPP, and x402, or a recognized public ODP/OpenAPI document URL. No enrollment or payment is performed.',
  ),
});

export const inspectOptions = z.object({
  method: z.string().default('GET').describe('HTTP method for the probe request.'),
  refresh: z.boolean().default(false).describe('Revalidate public documents and rediscover origin candidates.'),
  data: z
    .string()
    .optional()
    .describe(
      'Request body for the probe. JSON or raw text. Content-Type defaults to application/json when --data is set unless a --header overrides it.',
    ),
  header: z.array(z.string()).default([]).describe('Repeatable. "Name: Value" format.'),
});
