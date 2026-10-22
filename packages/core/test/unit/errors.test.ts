import { describe, expect, it } from 'vitest';
import { createApiError } from '../../src/resources/api-error.js';
import { userFacingErrorMessage } from '../../src/flows/api-error.js';
import {
  InflowApiError,
  InflowAuthenticationError,
  InflowConfigurationError,
  InflowSdkError,
  InflowTransportError,
} from '../../src/errors.js';

describe('errors', () => {
  it.each([{ errors: [] }, { errors: [null] }, { errors: [7] }, { errors: ['invalid'] }])(
    'handles malformed problem entries without losing HTTP status: %j',
    ({ errors }) => {
      const error = createApiError({ status: 403, data: { errors }, rawBody: '' }, 'Request rejected');
      expect(error.status).toBe(403);
      expect(error.message).toContain('Request rejected (403): unknown error');
    },
  );

  it.each([undefined, '', 7])('uses the supported install URL for an unusable install_url: %j', (installUrl) => {
    const error = createApiError(
      {
        status: 426,
        rawBody: '',
        data: {
          errors: [{ code: 'VERSION_UNSUPPORTED' }],
          install_url: installUrl,
        },
      },
      'Request rejected',
    );
    expect(error.code).toBe('VERSION_UNSUPPORTED');
    expect(error.message).toContain('https://inflowcli.ai/');
  });

  it('extracts the human message from a payment SDK error without diagnostic prefixes', () => {
    expect(
      userFacingErrorMessage({
        code: 'DECLINED',
        endpoint: '/v1/transactions',
        message: '[request] /v1/transactions: 403 DECLINED — Declined by owner.',
      }),
    ).toBe('Declined by owner.');
  });
  it.each(['', 'upstream unavailable', '{malformed json'])('preserves diagnostic response bodies: %j', (rawBody) => {
    const cause = new Error('upstream failure');
    const error = new InflowApiError('Request failed', { status: 502, rawBody, cause });
    expect(error.rawBody).toBe(rawBody);
    expect(error.cause).toBe(cause);
  });

  it('redacts nested credentials without mutating the supplied response', () => {
    const details = {
      entries: [{ access_token: 'secret', enabled: true, nested: { refresh_token: 'refresh' } }],
      count: 1,
      empty: null,
    };
    const error = new InflowApiError('Rejected', { status: 401, details, rawBody: JSON.stringify(details) });
    const expected = {
      entries: [{ access_token: '<redacted>', enabled: true, nested: { refresh_token: '<redacted>' } }],
      count: 1,
      empty: null,
    };
    expect(error.details).toEqual(expected);
    expect(JSON.parse(error.rawBody ?? '')).toEqual(expected);
    expect(details.entries[0]?.access_token).toBe('secret');
  });
  it('InflowSdkError sets default code and name', () => {
    const e = new InflowSdkError('boom');
    expect(e.name).toBe('InflowSdkError');
    expect(e.message).toBe('boom');
    expect(e.code).toBe('sdk_error');
    expect(e.cause).toBeUndefined();
  });

  it('InflowSdkError accepts code and cause', () => {
    const cause = new Error('inner');
    const e = new InflowSdkError('boom', { code: 'x', cause });
    expect(e.code).toBe('x');
    expect(e.cause).toBe(cause);
  });

  it('InflowConfigurationError forces configuration_error code', () => {
    const e = new InflowConfigurationError('missing');
    expect(e.code).toBe('configuration_error');
    expect(e.name).toBe('InflowConfigurationError');
    expect(e).toBeInstanceOf(InflowSdkError);
  });

  it('InflowAuthenticationError forces not_authenticated code', () => {
    const e = new InflowAuthenticationError('login first');
    expect(e.code).toBe('not_authenticated');
    expect(e.name).toBe('InflowAuthenticationError');
  });

  it('InflowTransportError forces transport_error code', () => {
    const e = new InflowTransportError('network down', { cause: 'eof' });
    expect(e.code).toBe('transport_error');
    expect(e.cause).toBe('eof');
  });

  it('InflowApiError carries status, rawBody, details, code', () => {
    const e = new InflowApiError('nope', {
      status: 403,
      code: 'forbidden',
      rawBody: '{"x":1}',
      details: { x: 1 },
    });
    expect(e.status).toBe(403);
    expect(e.code).toBe('forbidden');
    expect(e.rawBody).toBe('{"x":1}');
    expect(e.details).toEqual({ x: 1 });
    expect(e.name).toBe('InflowApiError');
  });

  it('InflowApiError defaults code to api_error', () => {
    const e = new InflowApiError('nope', { status: 500 });
    expect(e.code).toBe('api_error');
    expect(e.rawBody).toBeUndefined();
    expect(e.details).toBeUndefined();
  });
});
