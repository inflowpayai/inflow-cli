import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const here = dirname(fileURLToPath(import.meta.url));

interface CliManifest {
  version: string;
}

const manifest = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf-8')) as CliManifest;

export default defineConfig({
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
  define: {
    __CLI_VERSION__: JSON.stringify(manifest.version),
  },
  dts: true,
  entry: { 'npm-shim': 'src/npm-shim.ts' },
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  sourcemap: false,
  target: 'node24',
});
