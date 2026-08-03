import { z } from 'incur';

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
  query: z.string().optional().describe('Optional free-text Service query.'),
});

export const directorySearchOptions = z.object({
  keyword: z.array(z.string()).default([]).describe('Repeatable Service keyword filter.'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum Services requested in this page.'),
  next: z.string().optional().describe('Opaque continuation URL from an earlier directory response.'),
  enrollment: z
    .array(z.enum(['aep']))
    .default([])
    .describe('Repeatable enrollment protocol filter.'),
  operation: z.array(operation).default([]).describe('Repeatable ODP operation filter.'),
  payment: z
    .array(z.enum(['mpp', 'x402']))
    .default([])
    .describe('Repeatable payment protocol filter.'),
});

export const directorySuggestArgs = z.object({
  prefix: z.string().describe('Keyword prefix to complete.'),
});

export const directorySuggestOptions = z.object({
  limit: z.number().int().min(1).max(25).optional().describe('Maximum suggestions to return.'),
});

const serviceArgs = z.object({
  service: z.string().describe('ODP Service URL or origin.'),
});

const languageOption = {
  language: z.string().optional().describe('Preferred response language sent through Accept-Language.'),
};

export const inspectArgs = serviceArgs;
export const inspectOptions = z.object(languageOption);

export const collectionListArgs = serviceArgs;
export const collectionListOptions = z.object({
  ...languageOption,
  limit: z.number().int().min(1).max(100).optional().describe('Maximum Collections requested in this page.'),
  next: z.string().optional().describe('Opaque continuation URL from an earlier Collection response.'),
});

export const collectionSearchArgs = z.object({
  service: z.string().describe('ODP Service URL or origin.'),
  query: z.string().optional().describe('Optional free-text Collection query.'),
});

export const collectionSearchOptions = z.object({
  ...languageOption,
  limit: z.number().int().min(1).max(100).optional().describe('Maximum Collections requested in this page.'),
  next: z.string().optional().describe('Opaque continuation URL from an earlier Collection search response.'),
  parentId: z.string().optional().describe('Restrict results to direct children of this Collection identifier.'),
});

export const collectionGetArgs = z.object({
  service: z.string().describe('ODP Service URL or origin.'),
  id: z.string().describe('Collection identifier.'),
});

export const collectionGetOptions = z.object(languageOption);

export const offeringListArgs = serviceArgs;
export const offeringListOptions = z.object({
  ...languageOption,
  collectionId: z.string().optional().describe('List Offerings from this Collection.'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum Offerings requested in this page.'),
  next: z.string().optional().describe('Opaque continuation URL from an earlier Offering response.'),
});

export const offeringSearchArgs = z.object({
  service: z.string().describe('ODP Service URL or origin.'),
  query: z.string().optional().describe('Optional free-text Offering query.'),
});

export const offeringSearchOptions = z.object({
  ...languageOption,
  collectionId: z.string().optional().describe('Restrict results to this Collection.'),
  filter: z.array(z.string()).default([]).describe('Repeatable JSON-encoded ODP filter expression.'),
  includeDescendants: z.boolean().optional().describe('Include descendant Collections in the search.'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum Offerings requested in this page.'),
  next: z.string().optional().describe('Opaque continuation URL from an earlier Offering search response.'),
  refinement: z.array(z.string()).default([]).describe('Repeatable filter identifier to refine.'),
  sort: z.string().optional().describe('Advertised sort identifier.'),
});

export const offeringCapabilitiesArgs = serviceArgs;
export const offeringCapabilitiesOptions = z.object({
  ...languageOption,
  collectionId: z.string().optional().describe('Resolve capabilities for this Collection.'),
});

export const offeringGetArgs = z.object({
  service: z.string().describe('ODP Service URL or origin.'),
  id: z.string().describe('Offering identifier.'),
});

export const offeringGetOptions = z.object(languageOption);

export const offeringDiscoverArgs = z.object({
  query: z.string().optional().describe('Optional free-text Offering query sent to each selected Service.'),
});

export const offeringDiscoverOptions = z.object({
  collectionId: z.string().optional().describe('Restrict Offering discovery to this Collection identifier.'),
  concurrency: z.number().int().min(1).max(16).optional().describe('Maximum concurrent Service searches.'),
  filter: z.array(z.string()).default([]).describe('Repeatable JSON-encoded ODP filter expression.'),
  includeDescendants: z.boolean().optional().describe('Include descendant Collections in Offering searches.'),
  keyword: z.array(z.string()).default([]).describe('Repeatable directory Service keyword filter.'),
  maxOfferingsPerService: z.number().int().min(1).max(100).optional().describe('Maximum Offerings per Service.'),
  maxServices: z.number().int().min(1).max(100).optional().describe('Maximum Services queried.'),
  enrollment: z
    .array(z.enum(['aep']))
    .default([])
    .describe('Repeatable directory enrollment protocol filter.'),
  operation: z
    .array(operation)
    .default([])
    .describe('Repeatable directory ODP operation filter; inferred from the Offering request when omitted.'),
  payment: z
    .array(z.enum(['mpp', 'x402']))
    .default([])
    .describe('Repeatable directory payment protocol filter.'),
  refinement: z.array(z.string()).default([]).describe('Repeatable filter identifier to refine.'),
  serviceQuery: z.string().optional().describe('Free-text query used only to select Services from the directory.'),
  sort: z.string().optional().describe('Advertised sort identifier sent to each selected Service.'),
});

export const actionResolveArgs = z.object({
  service: z.string().describe('ODP Service URL or origin.'),
  offeringId: z.string().describe('Offering identifier.'),
  actionId: z.string().describe('Action identifier from the full Offering.'),
});
