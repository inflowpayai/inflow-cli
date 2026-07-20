import { describe, expect, it } from 'vitest';
import { sanitizeDeep, sanitizeText } from '../../../src/utils/sanitize-text.js';

describe('sanitizeText', () => {
  it('returns empty string for null and undefined', () => {
    expect(sanitizeText(null)).toBe('');
    expect(sanitizeText(undefined)).toBe('');
    expect(sanitizeText('')).toBe('');
  });

  it('passes through clean strings unchanged (fast path)', () => {
    expect(sanitizeText('hello world')).toBe('hello world');
    expect(sanitizeText('  spaces and tabs\there\n')).toBe('  spaces and tabs\there\n');
  });

  it('strips ANSI escape sequences', () => {
    const input = '\x1b[31mred\x1b[0m text';
    expect(sanitizeText(input)).toBe('red text');
  });

  it('strips control characters in the deny list', () => {
    const input = `start\x01mid\x02end\rfinal`;
    expect(sanitizeText(input)).toBe('startmidendfinal');
  });

  it('preserves newline and tab', () => {
    expect(sanitizeText('line1\nline2\tcol')).toBe('line1\nline2\tcol');
  });
});

describe('sanitizeDeep', () => {
  it('returns null and undefined unchanged', () => {
    expect(sanitizeDeep(null)).toBeNull();
    expect(sanitizeDeep(undefined)).toBeUndefined();
  });

  it('returns primitives unchanged', () => {
    expect(sanitizeDeep(42)).toBe(42);
    expect(sanitizeDeep(true)).toBe(true);
  });

  it('sanitizes plain strings', () => {
    expect(sanitizeDeep('\x1b[31mhi\x1b[0m')).toBe('hi');
  });

  it('walks arrays recursively', () => {
    const out = sanitizeDeep(['\x1b[31ma\x1b[0m', 'b', 1]);
    expect(out).toEqual(['a', 'b', 1]);
  });

  it('preserves URL instances', () => {
    const url = new URL('https://service.example/.well-known/aep');

    expect(sanitizeDeep(url)).toBe(url);
  });

  it('walks nested objects', () => {
    const out = sanitizeDeep({
      name: '\x1b[31mhi\x1b[0m',
      meta: { code: '\x01abc', items: ['\x1b[32mok\x1b[0m'] },
    });
    expect(out).toEqual({
      name: 'hi',
      meta: { code: 'abc', items: ['ok'] },
    });
  });
});
