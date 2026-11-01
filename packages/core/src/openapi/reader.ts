import { isRecord, type PublicSourceDocuments, type SourceDocument, type SourceOptions } from './documents.js';
import { publicDocumentUrl } from './public-fetch.js';
import { operationPayment, type OpenApiPayment } from './payments.js';

export interface OpenApiOperation {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  tags?: string[];
  description?: string;
  servers: Record<string, unknown>[];
  parameters: Record<string, unknown>[];
  requestBody?: Record<string, unknown>;
  security: Record<string, string[]>[];
  securitySchemes: Record<string, Record<string, unknown>>;
  limitations: string[];
  payment?: OpenApiPayment;
}

export interface OpenApiDescription {
  sourceUrl: string;
  retrievalUrl: string;
  version: string;
  title: string;
  description?: string;
  operations: OpenApiOperation[];
  limitations: string[];
}

export function openApiDocument(value: unknown): Record<string, unknown> {
  if (
    !isRecord(value) ||
    typeof value['openapi'] !== 'string' ||
    !/^3\.\d+(?:\.|$)/.test(value['openapi']) ||
    !isRecord(value['info']) ||
    typeof value['info']['title'] !== 'string' ||
    (value['paths'] !== undefined && !isRecord(value['paths']))
  ) {
    throw new TypeError('Expected a JSON OpenAPI 3.x document with info.title and an object-valued paths field.');
  }
  return value;
}

export async function readOpenApi(
  document: SourceDocument,
  documents: PublicSourceDocuments,
  options: SourceOptions,
): Promise<OpenApiDescription> {
  const root = openApiDocument(document.value);
  const references = new References(document, documents, options);
  const operations: OpenApiOperation[] = [];
  const limitations: string[] = [];
  const schemeEntries: [string, Record<string, unknown>][] = [];
  const components = isRecord(root['components']) ? root['components'] : {};
  if (isRecord(components['securitySchemes'])) {
    for (const [name, scheme] of Object.entries(components['securitySchemes'])) {
      const resolved = await references.resolve(scheme, document.finalUrl);
      schemeEntries.push([name, resolved.value]);
    }
  }
  const schemes = Object.fromEntries(schemeEntries);
  const paths = isRecord(root['paths']) ? root['paths'] : {};
  for (const [path, rawItem] of Object.entries(paths)) {
    if (path.startsWith('x-')) continue;
    if (!path.startsWith('/')) throw new TypeError('OpenAPI path keys must start with /.');
    const item = await references.resolve(rawItem, document.finalUrl);
    for (const method of ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']) {
      const raw = item.value[method];
      if (raw === undefined) continue;
      if (!isRecord(raw)) throw new TypeError(`Invalid OpenAPI operation: ${method} ${path}`);
      const parameters = new Map<string, Record<string, unknown>>();
      for (const group of [item.value['parameters'], raw['parameters']]) {
        if (group === undefined) continue;
        if (!Array.isArray(group)) throw new TypeError('OpenAPI parameters must be an array.');
        for (const parameter of group) {
          const parameterReference = await references.resolve(parameter, item.url);
          const resolved = references.schemas(parameterReference.value, parameterReference.url);
          if (typeof resolved['name'] !== 'string' || typeof resolved['in'] !== 'string')
            throw new TypeError('OpenAPI parameters require name and in.');
          parameters.set(`${resolved['in']}:${resolved['name']}`, resolved);
        }
      }
      const operation: OpenApiOperation = {
        method: method.toUpperCase(),
        path,
        servers: servers(
          raw['servers'] ?? item.value['servers'] ?? root['servers'],
          raw['servers'] !== undefined || item.value['servers'] !== undefined ? item.url : document.finalUrl,
        ),
        parameters: [...parameters.values()],
        security: security(raw['security'] ?? root['security']),
        securitySchemes: schemes,
        limitations: [],
        payment: operationPayment(raw),
      };
      for (const field of ['operationId', 'summary', 'description'] as const) {
        if (typeof raw[field] === 'string') operation[field] = raw[field];
      }
      if (raw['tags'] !== undefined) {
        if (!Array.isArray(raw['tags']) || !raw['tags'].every((tag: unknown) => typeof tag === 'string'))
          throw new TypeError('OpenAPI operation tags must be an array of strings.');
        operation.tags = [...new Set<string>(raw['tags'])];
      }
      if (raw['requestBody'] !== undefined) {
        const bodyReference = await references.resolve(raw['requestBody'], item.url);
        operation.requestBody = references.schemas(bodyReference.value, bodyReference.url);
      }
      for (const parameter of operation.parameters) {
        if (!['path', 'query', 'header'].includes(String(parameter['in'])))
          operation.limitations.push(
            `Parameter ${String(parameter['name'])} uses unsupported location ${String(parameter['in'])}.`,
          );
        const schema = parameter['schema'];
        if (
          isRecord(schema) &&
          (schema['$ref'] !== undefined ||
            schema['type'] === 'object' ||
            schema['oneOf'] !== undefined ||
            schema['anyOf'] !== undefined)
        ) {
          operation.limitations.push(
            `Parameter ${String(parameter['name'])} requires schema interpretation during preparation.`,
          );
        }
      }
      if (operation.requestBody !== undefined) {
        const content = operation.requestBody['content'];
        if (
          !isRecord(content) ||
          !Object.keys(content).some((media) => media === 'application/json' || media.endsWith('+json'))
        )
          operation.limitations.push('Request body does not advertise a JSON media type.');
      }
      if (raw['callbacks'] !== undefined) operation.limitations.push('Callback listeners are not supported.');
      operations.push(operation);
    }
    for (const feature of ['query', 'additionalOperations'])
      if (item.value[feature] !== undefined) limitations.push(`Path ${path} uses unsupported ${feature}.`);
  }
  if (root['webhooks'] !== undefined) limitations.push('Webhook listeners are not supported.');
  const info = root['info'];
  // openApiDocument checks these fields at the JSON boundary.
  if (!isRecord(info) || typeof info['title'] !== 'string' || typeof root['openapi'] !== 'string')
    throw new TypeError('Invalid OpenAPI metadata.');
  return {
    sourceUrl: document.sourceUrl,
    retrievalUrl: document.finalUrl,
    title: info['title'],
    version: root['openapi'],
    ...(typeof info['description'] === 'string' ? { description: info['description'] } : {}),
    operations,
    limitations,
  };
}

function security(value: unknown): Record<string, string[]>[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every(
      (item: unknown) =>
        isRecord(item) &&
        Object.values(item).every(
          (scopes: unknown) => Array.isArray(scopes) && scopes.every((scope: unknown) => typeof scope === 'string'),
        ),
    )
  )
    throw new TypeError('Invalid OpenAPI security requirements.');
  return value as Record<string, string[]>[];
}

function servers(value: unknown, base: string): Record<string, unknown>[] {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) return [{ url: new URL('/', base).href }];
  if (!Array.isArray(value)) throw new TypeError('OpenAPI servers must be an array.');
  return value.map((server: unknown) => {
    if (!isRecord(server) || typeof server['url'] !== 'string') throw new TypeError('OpenAPI server requires a URL.');
    // Preserve variables for explicit selection and overrides during preparation.
    return { ...server, url: server['url'], baseUrl: base };
  });
}

class References {
  private readonly loaded = new Map<string, SourceDocument>();
  constructor(
    document: SourceDocument,
    private readonly documents: PublicSourceDocuments,
    private readonly options: SourceOptions,
  ) {
    this.loaded.set(document.sourceUrl, document);
    this.loaded.set(document.finalUrl, document);
  }
  private externalCount = 0;
  private readonly schemaBudget = { remaining: 10_000 };

  schemas(value: Record<string, unknown>, base: string): Record<string, unknown> {
    const document = this.loaded.get(base);
    if (document === undefined) return value;
    if (
      isRecord(document.value) &&
      document.value['jsonSchemaDialect'] !== undefined &&
      document.value['jsonSchemaDialect'] !== 'https://spec.openapis.org/oas/3.1/dialect/base'
    )
      return value;
    const resolve = (schema: unknown) => localSchema(schema, document.value, new Set(), this.schemaBudget);
    const result = { ...value };
    if (value['schema'] !== undefined) result['schema'] = resolve(value['schema']);
    if (isRecord(value['content'])) {
      result['content'] = Object.fromEntries(
        Object.entries(value['content']).map(([type, media]) => [
          type,
          isRecord(media) && media['schema'] !== undefined ? { ...media, schema: resolve(media['schema']) } : media,
        ]),
      );
    }
    return result;
  }

  async resolve(
    value: unknown,
    base: string,
    seen = new Set<string>(),
  ): Promise<{ value: Record<string, unknown>; url: string }> {
    if (!isRecord(value)) throw new TypeError('OpenAPI reference target must be an object.');
    const ref = value['$ref'];
    if (ref === undefined) return { value, url: base };
    if (typeof ref !== 'string') throw new TypeError('OpenAPI $ref must be a string.');
    if (Object.keys(value).some((key) => !key.startsWith('x-') && !['$ref', 'summary', 'description'].includes(key))) {
      throw new TypeError('OpenAPI reference siblings other than summary and description are not supported here.');
    }
    const target = new URL(ref, base);
    if (seen.has(target.href) || seen.size >= 16)
      throw new TypeError('OpenAPI reference cycle or depth limit exceeded.');
    seen.add(target.href);
    const fragment = decodeURIComponent(target.hash.slice(1));
    target.hash = '';
    publicDocumentUrl(target.href);
    let document = this.loaded.get(target.href);
    if (document === undefined) {
      if (++this.externalCount > 8) throw new TypeError('OpenAPI document exceeds eight external references.');
      document = await this.documents.get(target.href, this.options);
      if (document.status !== 200) throw new TypeError('OpenAPI reference document is unavailable.');
      this.loaded.set(target.href, document);
      this.loaded.set(document.finalUrl, document);
    }
    let data = document.value;
    const retrievalUrl = document.finalUrl;
    if (fragment !== '') {
      if (!fragment.startsWith('/')) throw new TypeError('Only JSON pointer reference fragments are supported.');
      for (const part of fragment.slice(1).split('/')) {
        if (/~(?:[^01]|$)/.test(part)) throw new TypeError('Invalid JSON pointer escape.');
        const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
        if ((!isRecord(data) && !Array.isArray(data)) || !Object.hasOwn(data, key))
          throw new TypeError('OpenAPI reference target is missing.');
        data = Reflect.get(data, key) as unknown;
      }
    }
    const resolved = await this.resolve(data, retrievalUrl, seen);
    const result = { ...resolved.value };
    for (const field of ['summary', 'description']) if (typeof value[field] === 'string') result[field] = value[field];
    return { value: result, url: resolved.url };
  }
}

function localSchema(
  schema: unknown,
  document: unknown,
  seen: Set<unknown>,
  budget: { remaining: number },
  depth = 0,
): unknown {
  if (!isRecord(schema) || --budget.remaining < 0 || depth > 32 || seen.has(schema)) return schema;
  if (schema['$id'] !== undefined || schema['$schema'] !== undefined) return schema;
  const next = new Set(seen).add(schema);
  const resolve = (value: unknown) => localSchema(value, document, next, budget, depth + 1);
  if (schema['$ref'] !== undefined) {
    // Schema reference siblings have version-dependent semantics; keep them unsupported rather than discard constraints.
    if (Object.keys(schema).length !== 1 || typeof schema['$ref'] !== 'string' || !schema['$ref'].startsWith('#/'))
      return schema;
    let fragment: string;
    try {
      fragment = decodeURIComponent(schema['$ref'].slice(2));
    } catch {
      return schema;
    }
    let target = document;
    for (const part of fragment.split('/')) {
      if (/~(?:[^01]|$)/.test(part)) return schema;
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      if (
        (!isRecord(target) && !Array.isArray(target)) ||
        (isRecord(target) && (target['$id'] !== undefined || target['$schema'] !== undefined)) ||
        !Object.hasOwn(target, key)
      )
        return schema;
      target = Reflect.get(target, key) as unknown;
    }
    if ((!isRecord(target) && typeof target !== 'boolean') || next.has(target)) return schema;
    if (isRecord(target) && (target['$id'] !== undefined || target['$schema'] !== undefined)) return schema;
    return resolve(target);
  }
  const result = { ...schema };
  if (isRecord(schema['properties']))
    result['properties'] = Object.fromEntries(
      Object.entries(schema['properties']).map(([name, property]) => [name, resolve(property)]),
    );
  for (const key of ['items', 'additionalProperties']) {
    if (schema[key] !== undefined) result[key] = resolve(schema[key]);
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(schema[key])) result[key] = schema[key].map(resolve);
  }
  return result;
}
