import { describe, expect, it } from 'vitest';
import { loginOptions, statusOptions } from '../../../../src/commands/auth/schema.js';

describe('loginOptions', () => {
  it('applies defaults when nothing is provided', () => {
    const parsed = loginOptions.parse({});
    expect(parsed).toEqual({
      clientName: 'InFlow',
      interval: 0,
      maxAttempts: 0,
      timeout: 300,
    });
  });

  it('coerces string numbers from argv into numbers', () => {
    const parsed = loginOptions.parse({
      interval: '5',
      maxAttempts: '12',
      timeout: '600',
    });
    expect(parsed.interval).toBe(5);
    expect(parsed.maxAttempts).toBe(12);
    expect(parsed.timeout).toBe(600);
  });

  it('passes a custom client name through', () => {
    const parsed = loginOptions.parse({ clientName: 'Cowork Test Run' });
    expect(parsed.clientName).toBe('Cowork Test Run');
  });
});

describe('statusOptions', () => {
  it('applies defaults when nothing is provided', () => {
    const parsed = statusOptions.parse({});
    expect(parsed).toEqual({
      interval: 0,
      maxAttempts: 0,
      timeout: 300,
      probe: false,
    });
  });

  it('accepts --probe', () => {
    expect(statusOptions.parse({ probe: true }).probe).toBe(true);
  });

  it('coerces string numbers from argv into numbers', () => {
    const parsed = statusOptions.parse({ interval: '2', maxAttempts: '10' });
    expect(parsed.interval).toBe(2);
    expect(parsed.maxAttempts).toBe(10);
  });
});
