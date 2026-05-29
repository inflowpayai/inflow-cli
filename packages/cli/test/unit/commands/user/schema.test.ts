import { describe, expect, it } from 'vitest';
import { getOptions } from '../../../../src/commands/user/schema.js';

describe('user getOptions', () => {
  it('parses an empty object to {}', () => {
    expect(getOptions.parse({})).toEqual({});
  });

  it('strips unknown keys (zod default), so callers cannot smuggle flags', () => {
    expect(getOptions.parse({ unknown: 'value', another: 42 })).toEqual({});
  });

  it('rejects non-object inputs', () => {
    expect(() => getOptions.parse('not-an-object')).toThrow();
    expect(() => getOptions.parse(null)).toThrow();
  });
});
