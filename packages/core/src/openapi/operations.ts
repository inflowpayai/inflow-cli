import type { OpenApiDescription, OpenApiOperation } from './reader.js';

export interface OpenApiOperationSelector {
  method?: string | undefined;
  operationId?: string | undefined;
  path?: string | undefined;
}

export class OpenApiOperationError extends Error {
  constructor(
    readonly code: 'OPENAPI_SELECTOR_INVALID' | 'OPENAPI_OPERATION_NOT_FOUND' | 'OPENAPI_OPERATION_AMBIGUOUS',
    message: string,
  ) {
    super(message);
    this.name = 'OpenApiOperationError';
  }
}

export function selectOpenApiOperation(
  document: OpenApiDescription,
  selector: OpenApiOperationSelector,
): OpenApiOperation {
  if (
    selector.operationId === undefined
      ? selector.method === undefined || selector.path === undefined
      : selector.method !== undefined || selector.path !== undefined
  ) {
    throw new OpenApiOperationError(
      'OPENAPI_SELECTOR_INVALID',
      'Select an operation with --method and --path, or with --operation-id alone.',
    );
  }
  const matches = document.operations.filter((operation) =>
    selector.operationId === undefined
      ? operation.method === selector.method?.toUpperCase() && operation.path === selector.path
      : operation.operationId === selector.operationId,
  );
  if (matches.length > 1)
    throw new OpenApiOperationError(
      'OPENAPI_OPERATION_AMBIGUOUS',
      'The operation identifier is not unique. Use --method and --path instead.',
    );
  const operation = matches[0];
  if (operation === undefined)
    throw new OpenApiOperationError(
      'OPENAPI_OPERATION_NOT_FOUND',
      'No operation matches this selector. Run openapi operations list for the available methods and paths.',
    );
  return operation;
}
