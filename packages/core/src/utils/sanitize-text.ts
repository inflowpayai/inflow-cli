import stripAnsi from 'strip-ansi';

const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\r]/g;

const NEEDS_SANITIZE_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\r\x1b]/;

/** `null`, `undefined`, and empty input collapse to `''` rather than throwing or passing the nullish value through. */
export function sanitizeText(input: string | undefined | null): string {
  if (!input) {
    return '';
  }

  if (!NEEDS_SANITIZE_RE.test(input)) {
    return input;
  }

  return stripAnsi(input).replace(CONTROL_CHAR_RE, '');
}

export function sanitizeDeep<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return sanitizeText(value) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry: unknown) => sanitizeDeep(entry)) as T;
  }

  if (value instanceof URL) {
    return value;
  }

  if (value instanceof Map) {
    return new Map([...value].map(([key, entry]) => [sanitizeDeep(key), sanitizeDeep(entry)])) as T;
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    const keys = Object.keys(value);

    for (const k of keys) {
      result[k] = sanitizeDeep((value as Record<string, unknown>)[k]);
    }

    return result as T;
  }

  return value;
}
