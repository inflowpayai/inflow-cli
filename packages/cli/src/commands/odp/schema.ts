import { z } from 'incur';
import { httpUrlArgument } from '../../utils/http-url-argument.js';
import { PAYMENT_FILTERS } from './payments.js';

const operation = z.enum([
  'get-collection',
  'get-offering',
  'list-collection-offerings',
  'list-collections',
  'list-offerings',
  'search-collections',
  'search-offerings',
]);

const strings = z.array(z.string());
const jsonObject = z.record(z.string(), z.unknown());
const authentication = z.enum(['not-required', 'optional', 'required']);
export const operationOutput = z
  .object({ name: z.string(), authentication })
  .describe('Operation and its authentication requirement.');
export const paymentProtocolOutput = z.object({
  name: z.string(),
  authentication: z.enum(['not-required', 'required']),
  options: strings.optional(),
});
const namedProtocol = z.object({ name: z.string() });
export const protocolsOutput = z
  .object({
    enrollment: z.array(namedProtocol).optional(),
    payments: z.array(paymentProtocolOutput).optional(),
    trust: z.array(namedProtocol).optional(),
  })
  .describe('Recognized enrollment, payment, and trust protocols.');
const image = z.object({
  src: z.string(),
  type: z.string().optional(),
  alt: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
});
const filter = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    type: z.string(),
    operators: strings,
    refinable: z.literal(true).optional(),
    unit: z
      .object({ system: z.string(), code: z.string(), title: z.string().optional() })
      .meta({ additionalProperties: true })
      .optional(),
  })
  .meta({ additionalProperties: true })
  .describe('Filter definition; decimal values are strings.');
const sort = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    keys: z.array(
      z
        .object({
          filter_id: z.string(),
          direction: z.enum(['ascending', 'descending']),
          missing: z.enum(['first', 'last']),
        })
        .meta({ additionalProperties: true }),
    ),
  })
  .meta({ additionalProperties: true });
const searchCapabilities = z
  .object({
    filters: z
      .union([z.object({ inline: z.array(filter) }), z.object({ linked: z.object({ href: z.string() }) })])
      .optional(),
    sorts: z
      .union([z.object({ inline: z.array(sort) }), z.object({ linked: z.object({ href: z.string() }) })])
      .optional(),
  })
  .meta({ additionalProperties: true })
  .describe('Inline or linked search definitions.');

export const serviceDocumentOutput = z
  .object({
    odp_version: z.string().describe('ODP protocol version.'),
    name: z.string().describe('Service name.'),
    description: z.string().describe('Service description.'),
    language: z.string().describe('Document language.'),
    localizations: strings.describe('Available languages.'),
    operations: z.array(operationOutput).describe('Recognized catalog operations.'),
    http: z
      .object({ endpoint_base: z.string(), openapi: z.object({ url: z.string() }).optional() })
      .meta({ additionalProperties: true })
      .describe('HTTP endpoints.'),
    protocols: protocolsOutput.optional(),
    branding: z.object({ icon: image, logo: image }).optional().describe('Service branding.'),
    mcp: z
      .array(
        z.object({
          type: z.literal('streamable-http'),
          url: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
        }),
      )
      .optional()
      .describe('Advertised MCP endpoints.'),
    payment_origins: strings
      .optional()
      .describe('Declared payment origins; advertisement alone does not prove ownership.'),
    keywords: strings.optional().describe('Service keywords.'),
    documentation_url: z.string().optional().describe('Documentation URL.'),
    status_url: z.string().optional().describe('Status URL.'),
    support_url: z.string().optional().describe('Support URL.'),
    website_url: z.string().optional().describe('Website URL.'),
    search_capabilities: searchCapabilities.optional(),
  })
  .meta({ additionalProperties: true });

export const inspectionOutput = z.object({
  document: serviceDocumentOutput.describe('Validated Service discovery document.'),
  requestedUrl: z
    .union([z.string(), z.instanceof(URL)])
    .describe('Requested discovery URL, serialized as a string.')
    .meta({ type: 'string' }),
  finalUrl: z
    .union([z.string(), z.instanceof(URL)])
    .describe('Final discovery URL, serialized as a string.')
    .meta({ type: 'string' }),
  serviceOrigin: z.string().describe('Service origin.'),
  freshness: z.enum(['fresh', 'revalidated', 'fetched']).describe('Cache freshness outcome.'),
  capabilities: z
    .object({
      enrollment: z.array(namedProtocol),
      operations: z.array(operationOutput),
      payments: z.array(paymentProtocolOutput),
      trust: z.array(namedProtocol),
    })
    .describe('Recognized Service capabilities.'),
});

const resource = z
  .object({
    id: z.string().describe('Service-local resource identifier.'),
    name: z.string().describe('Resource name.'),
    odp_version: z.string().optional().describe('ODP protocol version when included.'),
    auth_expands: z.literal(true).optional().describe('Authentication can expand the visible representation.'),
    description: z.string().optional().describe('Resource description.'),
    images: z.array(image).optional().describe('Resource images.'),
    language: z.string().optional().describe('Representation language.'),
    localizations: strings.optional().describe('Available languages.'),
    web_url: z.string().optional().describe('Human-readable resource URL.'),
    detail_fields: strings.optional().describe('Fields available in the full representation.'),
  })
  .meta({ additionalProperties: true });
const collection = resource
  .extend({
    parent_ids: strings.optional().describe('Parent Collection identifiers.'),
    search_capabilities: searchCapabilities.optional(),
  })
  .meta({ additionalProperties: true });
const offering = resource
  .extend({
    collection_ids: strings.optional().describe('Containing Collection identifiers.'),
    price: z
      .object({
        type: z.string(),
        amount: z.string().optional(),
        currency: z.string().optional(),
        minimum: z.string().optional(),
        maximum: z.string().optional(),
        unit: z.string().optional(),
      })
      .meta({ additionalProperties: true })
      .optional()
      .describe('Price preview, not a payment quote; amounts are decimal strings.'),
    schema: z.object({ url: z.string() }).optional().describe('Attribute schema reference.'),
    attributes: jsonObject.optional().describe('Provider-defined attributes.'),
  })
  .meta({ additionalProperties: true });
const action = z.object({
  id: z.string().describe('Action identifier.'),
  rel: z.string().describe('Action relation.'),
  authentication,
  description: z.string().optional(),
  target: z
    .union([
      z.object({
        kind: z.literal('http'),
        url: z.string(),
        method: z.enum(['GET', 'POST']),
        request: z
          .object({ content_type: z.string().optional(), schema: z.object({ url: z.string() }).optional() })
          .optional(),
        response_content_types: strings.optional(),
      }),
      z.object({ kind: z.literal('openapi'), url: z.string(), operation_id: z.string() }),
    ])
    .describe('Resolved HTTP or OpenAPI target; not invoked.'),
});
const page = z
  .object({
    odp_version: z.string().describe('ODP protocol version.'),
    service_origin: z.string().describe('Origin that owns these resource identifiers.'),
    next: z.string().optional().describe('Opaque continuation URL; pass as --next.'),
    auth_expands: z.literal(true).optional().describe('Authentication may expose additional results.'),
  })
  .meta({ additionalProperties: true });
export const collectionPageOutput = page
  .extend({ items: z.array(collection).describe('Collections on this page.') })
  .meta({ additionalProperties: true });
export const collectionOutput = z.object({
  collection: collection
    .extend({ odp_version: z.string() })
    .meta({ additionalProperties: true })
    .describe('Full Collection.'),
  service_origin: z.string().describe('Owning Service origin.'),
});
export const offeringPageOutput = page
  .extend({
    items: z.array(offering).describe('Offerings on this page.'),
    refinements: z
      .array(
        z
          .object({
            filter_id: z.string(),
            values: z.array(
              z
                .object({
                  value: z.union([z.string(), z.boolean(), z.number()]),
                  count: z.number(),
                  count_relation: z.literal('lower_bound').optional(),
                })
                .meta({ additionalProperties: true }),
            ),
          })
          .meta({ additionalProperties: true }),
      )
      .optional()
      .describe('Search refinement buckets.'),
  })
  .meta({ additionalProperties: true });
export const offeringOutput = z.object({
  service_origin: z.string().describe('Owning Service origin.'),
  offering: offering
    .extend({
      odp_version: z.string(),
      attribute_schema: jsonObject.optional().describe('Resolved provider JSON Schema.'),
      actions: z.array(action).optional().describe('Available resolved actions.'),
      issues: z
        .array(
          z.object({
            scope: z.enum(['attribute_schema', 'attributes', 'action']),
            message: z.string(),
            action_id: z.string().optional(),
          }),
        )
        .optional()
        .describe('Problems with individual Offering components.'),
    })
    .meta({ additionalProperties: true })
    .describe('Full Offering.'),
});
export const capabilitiesOutput = z.object({
  service_origin: z.string().describe('Owning Service origin.'),
  filters: z.array(filter).describe('Resolved filter definitions.'),
  sorts: z
    .array(sort.extend({ filters: z.array(filter) }).meta({ additionalProperties: true }))
    .describe('Resolved sort definitions and their filters.'),
  issues: z
    .array(
      z.object({ scope: z.enum(['service', 'collection']), kind: z.enum(['filters', 'sorts']), message: z.string() }),
    )
    .describe('Search definition issues.'),
});
export const directoryServiceOutput = serviceDocumentOutput
  .omit({ odp_version: true, http: true })
  .extend({
    service_origin: z.string().describe('Indexed Service origin.'),
    indexed_at: z.string().describe('Directory indexing timestamp.'),
  })
  .meta({ additionalProperties: true });
export const discoveryOutput = z.object({
  items: z
    .array(z.object({ service: directoryServiceOutput, offering }))
    .describe('Offerings paired with their directory Service metadata.'),
});
export const actionOutput = z.object({
  offering_id: z.string().describe('Owning Offering identifier.'),
  service_origin: z.string().describe('Owning Service origin.'),
  action: action.describe('Resolved action.'),
  request_schema: jsonObject.optional().describe('Resolved HTTP request JSON Schema.'),
  openapi_document: jsonObject.optional().describe('Provider OpenAPI document for an OpenAPI action.'),
  operation: jsonObject.optional().describe('Provider OpenAPI operation for an OpenAPI action.'),
});

const serviceArgs = z.object({
  service: httpUrlArgument.describe('ODP Service URL or origin.'),
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
  service: httpUrlArgument.describe('ODP Service URL or origin.'),
  query: z.string().optional().describe('Optional free-text Collection query.'),
});

export const collectionSearchOptions = z.object({
  ...languageOption,
  limit: z.number().int().min(1).max(100).optional().describe('Maximum Collections requested in this page.'),
  next: z.string().optional().describe('Opaque continuation URL from an earlier Collection search response.'),
  parentId: z.string().optional().describe('Restrict results to direct children of this Collection identifier.'),
});

export const collectionGetArgs = z.object({
  service: httpUrlArgument.describe('ODP Service URL or origin.'),
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
  service: httpUrlArgument.describe('ODP Service URL or origin.'),
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
  service: httpUrlArgument.describe('ODP Service URL or origin.'),
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
  operation: z
    .array(operation)
    .default([])
    .describe('Repeatable directory ODP operation filter; inferred from the Offering request when omitted.'),
  payment: z
    .array(z.enum(PAYMENT_FILTERS))
    .default([])
    .describe('Repeatable directory payment filter in protocol or protocol:option form.'),
  refinement: z.array(z.string()).default([]).describe('Repeatable filter identifier to refine.'),
  serviceQuery: z.string().optional().describe('Free-text query used only to select Services from the directory.'),
  sort: z.string().optional().describe('Advertised sort identifier sent to each selected Service.'),
  withAep: z.boolean().default(false).describe('Only query Services that advertise AEP.'),
});

export const actionResolveArgs = z.object({
  service: httpUrlArgument.describe('ODP Service URL or origin.'),
  offeringId: z.string().describe('Offering identifier.'),
  actionId: z.string().describe('Action identifier from the full Offering.'),
});
