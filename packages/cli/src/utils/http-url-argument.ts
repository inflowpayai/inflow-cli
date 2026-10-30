import { z } from 'incur';

export const httpUrlArgument = z
  .string()
  .trim()
  .overwrite((value) =>
    /^[^/?#]+:\d+(?:[/?#]|$)/.test(value) || !/^[a-z][a-z0-9+.-]*:/i.test(value) ? `https://${value}` : value,
  )
  .refine(
    (value) => {
      try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:';
      } catch {
        return false;
      }
    },
    { message: 'Enter an HTTP or HTTPS URL, or a hostname.' },
  );
