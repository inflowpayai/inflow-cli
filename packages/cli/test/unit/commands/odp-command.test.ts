import { describe, expect, it, vi } from 'vitest';
import { executeOdpCommand, odpCommandError } from '../../../src/commands/odp/command.js';

describe('ODP command boundary', () => {
  it('returns the framework error result without attempting presentation', async () => {
    const frameworkError = { type: 'framework-error' };
    const present = vi.fn(() => Promise.resolve());
    const context = {
      error: vi.fn(() => frameworkError as never),
    };

    const result = await executeOdpCommand(
      context,
      () => odpCommandError({ code: 'ODP_TEST_FAILED', message: 'ODP test failed.', retryable: false }),
      present,
      { code: 'ODP_FALLBACK', message: 'ODP fallback.', retryable: false },
    );

    expect(result).toBe(frameworkError);
    expect(context.error).toHaveBeenCalledWith({
      code: 'ODP_TEST_FAILED',
      message: 'ODP test failed.',
      retryable: false,
    });
    expect(present).not.toHaveBeenCalled();
  });

  it('maps unexpected execution and presentation errors to the command fallback', async () => {
    const context = { error: vi.fn(() => ({ type: 'framework-error' }) as never) };
    const fallback = { code: 'ODP_FALLBACK', message: 'ODP fallback.', retryable: false };

    await executeOdpCommand(
      context,
      () => Promise.reject(new Error('private execution detail')),
      () => Promise.resolve(),
      fallback,
    );
    await executeOdpCommand(
      context,
      () => Promise.resolve({ ok: true }),
      () => Promise.reject(new Error('private presentation detail')),
      fallback,
    );

    expect(context.error).toHaveBeenNthCalledWith(1, fallback);
    expect(context.error).toHaveBeenNthCalledWith(2, fallback);
  });
});
