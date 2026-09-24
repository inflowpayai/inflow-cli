import { describe, expect, it } from 'vitest';
import { selectOpenApiOperation } from '../../src/openapi/operations.js';
import type { OpenApiDescription, OpenApiOperation } from '../../src/openapi/reader.js';

const operation: OpenApiOperation = {
  method: 'GET',
  path: '/items/{id}',
  operationId: 'item',
  servers: [],
  parameters: [],
  security: [],
  securitySchemes: {},
  limitations: [],
};
const document: OpenApiDescription = {
  sourceUrl: 'https://example.com/spec',
  retrievalUrl: 'https://example.com/spec',
  version: '3.1.0',
  title: 'Items',
  limitations: [],
  operations: [operation],
};

describe('OpenAPI operation selection', () => {
  it('selects by method/path or unique operation ID without mutation', () => {
    const before = structuredClone(document);
    expect(selectOpenApiOperation(document, { method: 'get', path: '/items/{id}' })).toEqual(operation);
    expect(selectOpenApiOperation(document, { operationId: 'item' })).toEqual(operation);
    expect(document).toEqual(before);
  });
  it.each([
    {},
    { method: 'GET' },
    { path: '/items' },
    { operationId: 'item', method: 'GET' },
    { operationId: 'item', path: '/items' },
  ])('rejects invalid selector %j', (selector) => {
    expect(() => selectOpenApiOperation(document, selector)).toThrow(
      'Select an operation with --method and --path, or with --operation-id alone.',
    );
  });
  it.each([{ operationId: 'ITEM' }, { method: 'POST', path: '/items/{id}' }, { method: 'GET', path: '/items/1' }])(
    'rejects absent operations %j',
    (selector) => {
      expect(() => selectOpenApiOperation(document, selector)).toThrow('No operation matches this selector.');
    },
  );
  it('requires method/path when operation IDs are duplicated', () => {
    expect(() =>
      selectOpenApiOperation(
        { ...document, operations: [operation, { ...operation, path: '/other' }] },
        { operationId: 'item' },
      ),
    ).toThrow('The operation identifier is not unique.');
  });
});
