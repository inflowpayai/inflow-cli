import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InflowApiError, InflowTransportError } from '../../../src/errors.js';
import { UserResource } from '../../../src/resources/user.js';
import { BASE_URL, userHappy } from '../fixtures/handlers.js';
import { makeServer } from '../fixtures/server.js';

const server = makeServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('UserResource', () => {
  it('returns the User shape verbatim', async () => {
    server.use(userHappy);
    const r = new UserResource({
      apiBaseUrl: BASE_URL,
      accessToken: 'tk',
    });
    const user = await r.retrieve();
    expect(user.userId).toBe('u-1');
    expect(user.email).toBe('a@example.com');
    expect(user.firstName).toBeNull();
    expect(user.locale).toBe('EN_US');
  });

  it('throws InflowApiError on non-2xx (e.g., 404)', async () => {
    server.use(http.get(`${BASE_URL}/v1/users/self`, () => new HttpResponse(null, { status: 404 })));
    const r = new UserResource({
      apiBaseUrl: BASE_URL,
      accessToken: 'tk',
    });
    await expect(r.retrieve()).rejects.toBeInstanceOf(InflowApiError);
  });

  it('surfaces unsupported CLI version responses with the upgrade link', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/users/self`, () =>
        HttpResponse.json(
          {
            errors: [
              {
                code: 'VERSION_UNSUPPORTED',
                message: 'This version of the InFlow CLI is not supported.',
                parameter: 'InFlow-CLI-Version',
              },
            ],
            current_version: '0.8.0',
            minimum_supported_version: '0.9.0',
            latest_version: '0.9.1',
            install_url: 'https://inflowcli.ai/',
          },
          { status: 426 },
        ),
      ),
    );
    const r = new UserResource({
      apiBaseUrl: BASE_URL,
      accessToken: 'tk',
    });

    let error: unknown;
    try {
      await r.retrieve();
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(InflowApiError);
    expect((error as InflowApiError).status).toBe(426);
    expect((error as InflowApiError).code).toBe('VERSION_UNSUPPORTED');
    expect((error as InflowApiError).message).toBe(
      'This InFlow CLI version is no longer supported.\nInstall the latest version: https://inflowcli.ai/',
    );
    expect((error as InflowApiError).details).toMatchObject({
      current_version: '0.8.0',
      minimum_supported_version: '0.9.0',
      latest_version: '0.9.1',
      install_url: 'https://inflowcli.ai/',
    });
  });

  it('uses problem detail messages for ordinary API failures', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/users/self`, () =>
        HttpResponse.json(
          {
            errors: [
              {
                code: 'account_locked',
                message: 'Account access is locked.',
              },
            ],
          },
          { status: 403 },
        ),
      ),
    );
    const r = new UserResource({
      apiBaseUrl: BASE_URL,
      accessToken: 'tk',
    });

    await expect(r.retrieve()).rejects.toMatchObject({
      code: 'account_locked',
      message: 'Failed to retrieve user (403): Account access is locked.',
      status: 403,
    });
  });

  it('aborts the underlying fetch when the caller-supplied signal fires', async () => {
    server.use(
      http.get(`${BASE_URL}/v1/users/self`, async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return HttpResponse.json({});
      }),
    );
    const r = new UserResource({
      apiBaseUrl: BASE_URL,
      accessToken: 'tk',
    });
    const controller = new AbortController();
    const pending = r.retrieve({ signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toBeInstanceOf(InflowTransportError);
  });
});
