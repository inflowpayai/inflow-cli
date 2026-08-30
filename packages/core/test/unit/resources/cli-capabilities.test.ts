import { afterEach, describe, expect, it, vi } from 'vitest';
import { Inflow, InflowApiError } from '../../../src/index.js';

afterEach(() => vi.restoreAllMocks());

describe('CLI capabilities', () => {
  it('fetches once and caches enabled features without authentication', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(Response.json({ features: ['visa_tap'], minimumSupportedVersion: '0.12.1' }));
    const inflow = new Inflow({ apiBaseUrl: 'https://platform.example', fetch });

    await expect(inflow.capabilities.has('visa_tap')).resolves.toBe(true);
    await expect(inflow.capabilities.get()).resolves.toEqual({
      features: ['visa_tap'],
      minimumSupportedVersion: '0.12.1',
    });

    expect(fetch).toHaveBeenCalledOnce();
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).has('Authorization')).toBe(false);
  });

  it('refreshes an expired cache and defaults malformed responses to disabled', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ features: ['visa_tap'], minimumSupportedVersion: '0.12.1' }))
      .mockResolvedValueOnce(Response.json({ features: 'visa_tap' }));
    const inflow = new Inflow({ apiBaseUrl: 'https://platform.example', capabilitiesMaxAgeMs: 0, fetch });

    await expect(inflow.capabilities.has('visa_tap')).resolves.toBe(true);
    await expect(inflow.capabilities.has('visa_tap')).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fails closed on transport errors but preserves HTTP 426 upgrade errors', async () => {
    const unavailable = new Inflow({
      apiBaseUrl: 'https://platform.example',
      fetch: vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('offline')),
    });
    await expect(unavailable.capabilities.get()).resolves.toEqual({ features: [], minimumSupportedVersion: '' });

    const unsupported = new Inflow({
      apiBaseUrl: 'https://platform.example',
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json(
          {
            errors: [{ code: 'VERSION_UNSUPPORTED', message: 'unsupported' }],
            install_url: 'https://inflowcli.ai/',
          },
          { status: 426 },
        ),
      ),
    });
    await expect(unsupported.capabilities.get()).rejects.toBeInstanceOf(InflowApiError);
  });
});
