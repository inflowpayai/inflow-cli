import { describe, expect, it } from 'vitest';
import reactDevtoolsCore from '../../../src/stubs/react-devtools-core.js';

describe('react-devtools-core stub', () => {
  it('exports a no-op connectToDevTools so the optional peer dep can be aliased', () => {
    expect(typeof reactDevtoolsCore.connectToDevTools).toBe('function');
    expect(reactDevtoolsCore.connectToDevTools()).toBeUndefined();
  });
});
