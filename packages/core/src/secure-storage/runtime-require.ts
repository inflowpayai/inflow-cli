import { createRequire } from 'node:module';

export function runtimeRequire(): NodeRequire {
  const embeddedRequire: unknown = Reflect.get(globalThis, '__inflowRequire');
  if (typeof embeddedRequire === 'function') {
    // The standalone launcher installs a NodeRequire before evaluating the embedded bundle.
    return embeddedRequire as NodeRequire;
  }
  return createRequire(import.meta.url);
}
