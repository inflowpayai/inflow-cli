import { z } from 'incur';

export const documentArgs = z.object({
  source: z.string().describe('HTTPS origin or exact public OpenAPI JSON document URL.'),
});

export const listOptions = z.object({
  refresh: z.boolean().default(false).describe('Revalidate documents and rediscover locations for an origin.'),
});

export const getOptions = listOptions.extend({
  method: z.string().optional().describe('HTTP method, together with --path.'),
  operationId: z.string().optional().describe('Unique operationId, instead of --method and --path.'),
  path: z.string().optional().describe('Exact documented path template, together with --method.'),
});
