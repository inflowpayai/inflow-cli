const PLAIN_DECIMAL_RE = /^-?\d+(?:\.\d+)?$/u;

/**
 * Normalize server decimal response strings without converting through `Number`, so precision is preserved and
 * exponential notation is never introduced. Non-plain forms are returned unchanged.
 */
export function normalizeDecimalString(value: string): string {
  if (!PLAIN_DECIMAL_RE.test(value)) return value;

  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [rawInteger = '0', rawFraction] = unsigned.split('.');
  const integer = stripLeadingZeros(rawInteger);
  const fraction = rawFraction?.replace(/0+$/u, '') ?? '';

  if (integer === '0' && fraction.length === 0) return '0';
  const sign = negative ? '-' : '';
  return fraction.length === 0 ? `${sign}${integer}` : `${sign}${integer}.${fraction}`;
}

function stripLeadingZeros(value: string): string {
  const stripped = value.replace(/^0+/u, '');
  return stripped.length === 0 ? '0' : stripped;
}
