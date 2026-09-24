import { isDeepStrictEqual } from 'node:util';
import { isRecord } from './documents.js';
import { selectOpenApiOperation, type OpenApiOperationSelector } from './operations.js';
import { publicDocumentUrl } from './public-fetch.js';
import type { OpenApiDescription, OpenApiOperation } from './reader.js';

export interface OpenApiPreparationInput extends OpenApiOperationSelector {
  data?: string | undefined;
  headers?: Record<string, string> | undefined;
  parameters?: Record<string, unknown> | undefined;
  server?: number | undefined;
  serverVariables?: Record<string, unknown> | undefined;
}

export interface PreparedOpenApiRequest {
  authentication: { requirements: Record<string, string[]>[]; verified: false };
  limitations: string[];
  operation: { method: string; path: string; operationId?: string };
  request: { method: string; url: string; headers: Record<string, string>; body?: string };
  source: { type: 'openapi'; url: string };
}

export class OpenApiPreparationError extends Error {
  constructor(
    readonly code:
      | 'OPENAPI_INPUT_INVALID'
      | 'OPENAPI_INPUT_REQUIRED'
      | 'OPENAPI_SERVER_REQUIRED'
      | 'OPENAPI_SERVER_INVALID'
      | 'OPENAPI_PREPARATION_UNSUPPORTED',
    message: string,
  ) {
    super(message);
    this.name = 'OpenApiPreparationError';
  }
}

function invalid(message: string): never {
  throw new OpenApiPreparationError('OPENAPI_INPUT_INVALID', message);
}

function required(label: string): never {
  throw new OpenApiPreparationError('OPENAPI_INPUT_REQUIRED', `Required input is missing: ${label}.`);
}

function unsupported(message: string): never {
  throw new OpenApiPreparationError('OPENAPI_PREPARATION_UNSUPPORTED', message);
}

function encode(value: string): string {
  try {
    return encodeURIComponent(value).replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  } catch {
    return invalid('Input contains an unpaired Unicode surrogate.');
  }
}

function scalar(value: unknown, label: string): string {
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return unsupported(`${label} requires a scalar or an array of scalar values.`);
}

function checkSchema(value: unknown, schema: unknown, label: string, depth = 0): void {
  if (depth > 32) unsupported(`${label} exceeds the supported schema nesting depth.`);
  if (schema === undefined || schema === true) return;
  if (schema === false) invalid(`${label} is not permitted by its schema.`);
  if (!isRecord(schema)) invalid(`${label} has an invalid schema.`);
  for (const key of ['$ref', '$dynamicRef', 'allOf', 'anyOf', 'oneOf', 'not', 'if']) {
    if (schema[key] !== undefined) unsupported(`${label} uses unsupported schema keyword ${key}.`);
  }
  if (value === null && schema['nullable'] === true) return;
  const type = schema['type'];
  const types = Array.isArray(type) ? type : type === undefined ? [] : [type];
  if (
    types.length > 0 &&
    !types.some((item) => {
      switch (item) {
        case 'null':
          return value === null;
        case 'object':
          return isRecord(value);
        case 'array':
          return Array.isArray(value);
        case 'integer':
          return typeof value === 'number' && Number.isSafeInteger(value);
        case 'number':
          return typeof value === 'number' && Number.isFinite(value);
        case 'boolean':
          return typeof value === 'boolean';
        case 'string':
          return typeof value === 'string';
        default:
          return false;
      }
    })
  )
    invalid(`${label} does not match its declared type.`);
  if (Array.isArray(schema['enum']) && !schema['enum'].some((item) => isDeepStrictEqual(item, value)))
    invalid(`${label} is not one of its declared enum values.`);
  if (Object.hasOwn(schema, 'const') && !isDeepStrictEqual(schema['const'], value))
    invalid(`${label} does not match its declared constant.`);
  if (Array.isArray(value)) {
    for (const item of value) checkSchema(item, schema['items'], `${label} item`, depth + 1);
  }
  if (isRecord(value)) {
    const properties = isRecord(schema['properties']) ? schema['properties'] : {};
    if (Array.isArray(schema['required'])) {
      for (const name of schema['required']) {
        if (
          typeof name === 'string' &&
          !Object.hasOwn(value, name) &&
          !(isRecord(properties[name]) && properties[name]['readOnly'] === true)
        )
          required(`${label}.${name}`);
      }
    }
    for (const [name, item] of Object.entries(value)) {
      const child = Object.hasOwn(properties, name) ? properties[name] : schema['additionalProperties'];
      checkSchema(item, child, `${label}.${name}`, depth + 1);
    }
  }
}

function serverUrl(document: OpenApiDescription, operation: OpenApiOperation, input: OpenApiPreparationInput): URL {
  if (input.server === undefined && operation.servers.length > 1) {
    throw new OpenApiPreparationError(
      'OPENAPI_SERVER_REQUIRED',
      `Multiple servers are advertised. Select one with --server:\n${operation.servers
        .map((server, index) => `  ${index + 1}  ${String(server['url'])}`)
        .join('\n')}`,
    );
  }
  const index = input.server ?? 1;
  const server = operation.servers[index - 1];
  if (!Number.isInteger(index) || server === undefined || typeof server['url'] !== 'string')
    throw new OpenApiPreparationError(
      'OPENAPI_SERVER_INVALID',
      'Select an advertised server using its one-based --server number.',
    );
  const variables = isRecord(server['variables']) ? server['variables'] : {};
  const supplied = input.serverVariables ?? {};
  for (const name of Object.keys(supplied)) {
    if (!Object.hasOwn(variables, name)) invalid(`Unknown server variable: ${name}.`);
  }
  const address = server['url'].replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const definition = Object.hasOwn(variables, name) ? variables[name] : undefined;
    if (!isRecord(definition)) invalid(`Server variable ${name} has no definition.`);
    const value = Object.hasOwn(supplied, name) ? supplied[name] : definition['default'];
    if (typeof value !== 'string') required(`server variable ${name}`);
    if (Array.isArray(definition['enum']) && !definition['enum'].includes(value))
      invalid(`Server variable ${name} is not an advertised choice.`);
    if (/[{}\s?#@\\]/.test(value)) invalid(`Server variable ${name} contains unsupported URL characters.`);
    return value;
  });
  if (/[{}\s\\]/.test(address)) invalid('Server URL contains unresolved variables or invalid characters.');
  let url: URL;
  try {
    url = publicDocumentUrl(address, typeof server['baseUrl'] === 'string' ? server['baseUrl'] : document.retrievalUrl);
  } catch {
    throw new OpenApiPreparationError(
      'OPENAPI_SERVER_INVALID',
      'The selected server must resolve to a public HTTPS URL without credentials or a fragment.',
    );
  }
  if (url.search) unsupported('Server URLs with query parameters are not supported for preparation.');
  return url;
}

function header(name: string, value: string, target: Record<string, string>): void {
  const key = name.toLowerCase();
  if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) || /[^\x20-\x7e]/.test(value))
    invalid('Header names and values must be valid printable HTTP text.');
  if (
    [
      'host',
      'content-length',
      'transfer-encoding',
      'connection',
      'cookie',
      'set-cookie',
      'upgrade',
      'trailer',
      'te',
    ].includes(key)
  )
    unsupported(`Header ${name} is not supported as an operation input.`);
  if (Object.hasOwn(target, key)) invalid(`Header ${name} was supplied more than once.`);
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

function apiKeys(operation: OpenApiOperation): { location: string; name: string }[] {
  return Object.values(operation.securitySchemes).flatMap((scheme) =>
    scheme['type'] === 'apiKey' && typeof scheme['in'] === 'string' && typeof scheme['name'] === 'string'
      ? [{ location: scheme['in'], name: scheme['name'] }]
      : [],
  );
}

function parameters(operation: OpenApiOperation, input: OpenApiPreparationInput, headers: Record<string, string>) {
  const supplied = input.parameters ?? {};
  if (Object.keys(supplied).some((key) => !['path', 'query', 'header'].includes(key)))
    invalid('--parameters accepts only path, query, and header objects.');
  const groups = Object.fromEntries(
    ['path', 'query', 'header'].map((location) => {
      const group = Object.hasOwn(supplied, location) ? supplied[location] : {};
      if (!isRecord(group)) invalid(`--parameters.${location} must be an object.`);
      if (location === 'header') {
        const normalized: Record<string, unknown> = {};
        for (const [name, value] of Object.entries(group)) {
          const key = name.toLowerCase();
          if (Object.hasOwn(normalized, key)) invalid(`Header ${name} was supplied more than once.`);
          Object.defineProperty(normalized, key, { value, enumerable: true });
        }
        return [location, normalized];
      }
      return [location, group];
    }),
  );
  const consumed = new Set<string>();
  const query: [string, string][] = [];
  let path = operation.path;
  for (const parameter of operation.parameters) {
    const name = String(parameter['name']);
    const location = String(parameter['in']);
    const inputName = location === 'header' ? name.toLowerCase() : name;
    if (!['path', 'query', 'header'].includes(location)) {
      if (parameter['required'] === true)
        unsupported(`Required parameter ${name} uses unsupported location ${location}.`);
      continue;
    }
    if (location === 'header' && ['accept', 'content-type', 'authorization'].includes(name.toLowerCase())) continue;
    const group = groups[location];
    const present = group !== undefined && Object.hasOwn(group, inputName);
    let value = present ? group[inputName] : undefined;
    if (location === 'header' && Object.hasOwn(headers, name.toLowerCase())) {
      if (present) invalid(`Header ${name} was supplied both in --header and --parameters.`);
      value = headers[name.toLowerCase()];
    }
    const label = `${location} parameter ${name}`;
    if (value === undefined) {
      if (parameter['required'] === true || location === 'path') required(label);
      continue;
    }
    consumed.add(`${location}:${inputName}`);
    if (parameter['content'] !== undefined) unsupported(`${label} uses content-based parameter encoding.`);
    const style = parameter['style'] ?? (location === 'query' ? 'form' : 'simple');
    if (style !== (location === 'query' ? 'form' : 'simple') || parameter['allowReserved'] === true)
      unsupported(`${label} uses an unsupported style or allowReserved setting.`);
    if (parameter['explode'] !== undefined && typeof parameter['explode'] !== 'boolean')
      invalid(`${label} has an invalid explode setting.`);
    checkSchema(value, parameter['schema'], label);
    const values = (Array.isArray(value) ? value : [value]).map((item) => scalar(item, label));
    if (Array.isArray(value) && value.length === 0)
      unsupported(`${label} cannot serialize an empty array unambiguously.`);
    if (location === 'path') {
      if (!path.includes(`{${name}}`)) invalid(`Path parameter ${name} is not present in the operation path.`);
      const encoded = values.map(encode).join(',');
      path = path.split(`{${name}}`).join(encoded);
    } else if (location === 'query') {
      if (Array.isArray(value) && parameter['explode'] !== false)
        values.forEach((item) => query.push([encode(name), encode(item)]));
      else query.push([encode(name), values.map(encode).join(',')]);
    } else if (!Object.hasOwn(headers, name.toLowerCase())) header(name, values.map(encode).join(','), headers);
  }
  for (const [location, group] of Object.entries(groups)) {
    for (const [name, value] of Object.entries(group)) {
      if (consumed.has(`${location}:${name}`)) continue;
      if (location === 'query' && apiKeys(operation).some((key) => key.location === location && key.name === name)) {
        query.push([encode(name), encode(scalar(value, `query credential ${name}`))]);
      } else if (location === 'header') {
        header(name, scalar(value, `header ${name}`), headers);
      } else invalid(`Unknown ${location} parameter: ${name}.`);
    }
  }
  if (!path.startsWith('/') || /[{}?#\\\s]/.test(path))
    invalid('The operation path contains unresolved placeholders or unsupported characters.');
  if (path.split('/').some((segment) => /^(?:\.|%2e){1,2}$/i.test(segment)))
    invalid('Path inputs must not resolve to dot segments.');
  return { path, query };
}

function body(
  operation: OpenApiOperation,
  input: OpenApiPreparationInput,
  headers: Record<string, string>,
): string | undefined {
  if (input.data === undefined) {
    if (operation.requestBody?.['required'] === true) required('request body (--data)');
    return undefined;
  }
  if (['GET', 'HEAD'].includes(operation.method)) unsupported('GET and HEAD request bodies are not supported.');
  const content = operation.requestBody?.['content'];
  if (!isRecord(content)) invalid('This operation does not declare a request body.');
  const mediaTypes = Object.keys(content).filter(
    (media) => media === 'application/json' || /^application\/[^;]+\+json$/.test(media),
  );
  const selected =
    headers['content-type']?.split(';')[0]?.trim() ?? (mediaTypes.length === 1 ? mediaTypes[0] : undefined);
  if (selected === undefined || !mediaTypes.includes(selected))
    unsupported('Select one advertised JSON request-body media type with --header "Content-Type: ...".');
  const media = content[selected];
  if (!isRecord(media)) invalid('The selected request-body media type is invalid.');
  let value: unknown;
  try {
    value = JSON.parse(input.data, (_key: string, item: unknown) => {
      if (typeof item === 'number' && !Number.isFinite(item))
        invalid('--data contains a number outside the supported range.');
      return item;
    });
  } catch {
    invalid('--data must contain valid JSON.');
  }
  checkSchema(value, media['schema'], 'body');
  headers['content-type'] ??= selected;
  return input.data;
}

export function prepareOpenApiRequest(
  document: OpenApiDescription,
  input: OpenApiPreparationInput,
): PreparedOpenApiRequest {
  const operation = selectOpenApiOperation(document, input);
  const server = serverUrl(document, operation, input);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) header(name, value, headers);
  const encoded = parameters(operation, input, headers);
  const query = encoded.query.map(([key, value]) => `${key}=${value}`).join('&');
  const url = new URL(`${server.href.replace(/\/$/, '')}${encoded.path}${query === '' ? '' : `?${query}`}`).href;
  const data = body(operation, input, headers);
  return {
    authentication: { requirements: structuredClone(operation.security), verified: false },
    limitations: [
      ...document.limitations,
      ...operation.limitations,
      'Preparation checks required fields, basic types and enums, not full JSON Schema conformance. Authentication and payment requirements are not verified.',
    ],
    operation: {
      method: operation.method,
      path: operation.path,
      ...(operation.operationId === undefined ? {} : { operationId: operation.operationId }),
    },
    request: { method: operation.method, url, headers, ...(data === undefined ? {} : { body: data }) },
    source: { type: 'openapi', url: document.sourceUrl },
  };
}

export function previewOpenApiRequest(prepared: PreparedOpenApiRequest, operation: OpenApiOperation) {
  const preview = structuredClone(prepared);
  const redactions: { location: 'header' | 'query'; name: string }[] = [];
  const keys = apiKeys(operation);
  for (const name of Object.keys(preview.request.headers)) {
    if (
      ['authorization', 'proxy-authorization'].includes(name.toLowerCase()) ||
      keys.some((key) => key.location === 'header' && key.name.toLowerCase() === name.toLowerCase())
    ) {
      preview.request.headers[name] = '[REDACTED]';
      redactions.push({ location: 'header', name });
    }
  }
  const question = preview.request.url.indexOf('?');
  if (question !== -1) {
    const query = preview.request.url
      .slice(question + 1)
      .split('&')
      .map((part) => {
        const equals = part.indexOf('=');
        const name = decodeURIComponent(equals === -1 ? part : part.slice(0, equals));
        if (!keys.some((key) => key.location === 'query' && key.name === name)) return part;
        if (!redactions.some((key) => key.location === 'query' && key.name === name))
          redactions.push({ location: 'query', name });
        return `${encode(name)}=${encode('[REDACTED]')}`;
      });
    preview.request.url = `${preview.request.url.slice(0, question)}?${query.join('&')}`;
  }
  return { outcome: 'request-prepared' as const, ...preview, redactions };
}
