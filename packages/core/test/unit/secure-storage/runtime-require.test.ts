import { afterEach, describe, expect, it, vi } from 'vitest';
import { runtimeRequire } from '../../../src/secure-storage/runtime-require.js';

describe('runtimeRequire', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, '__inflowRequire');
  });

  it('uses the require function installed by the standalone launcher', () => {
    const embeddedRequire = vi.fn();
    Reflect.set(globalThis, '__inflowRequire', embeddedRequire);

    expect(runtimeRequire()).toBe(embeddedRequire);
  });
});
