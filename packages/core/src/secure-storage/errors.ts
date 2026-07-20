import { InflowSdkError } from '../errors.js';

export type SecureStorageErrorCode =
  | 'secure_storage_corrupt'
  | 'secure_storage_invalid_path'
  | 'secure_storage_io_error'
  | 'secure_storage_secret_missing'
  | 'secure_storage_unavailable';

export class SecureStorageError extends InflowSdkError {
  readonly secureStorageCode: SecureStorageErrorCode;

  constructor(code: SecureStorageErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause, code });
    this.name = 'SecureStorageError';
    this.secureStorageCode = code;
  }
}
