export function isDocumentInspect(
  input: string,
  options: { method?: string | undefined; data?: string | undefined; header: readonly string[] },
): boolean {
  if (options.method !== undefined || options.data !== undefined || options.header.length > 0) return false;
  try {
    const { pathname } = new URL(input);
    return (
      pathname === '/' ||
      pathname === '/.well-known/odp' ||
      pathname === '/.well-known/x402.json' ||
      pathname.toLowerCase().includes('openapi')
    );
  } catch {
    return false;
  }
}
