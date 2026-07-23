#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' && process.platform !== 'linux') {
  process.exit(0);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platformName = process.platform === 'darwin' ? 'darwin' : 'linux';
const source = join(repoRoot, `packages/core/native/vault_peer_${platformName}.c`);
const outputDirectory = join(repoRoot, 'packages/core/native/build');
const output = join(outputDirectory, `vault_peer_${platformName}.node`);
const nodeInclude = resolve(dirname(process.execPath), '../include/node');

mkdirSync(outputDirectory, { recursive: true });
const platformArguments =
  process.platform === 'darwin' ? ['-dynamiclib', '-undefined', 'dynamic_lookup'] : ['-shared', '-fPIC'];
execFileSync(
  'cc',
  ['-std=c11', '-Wall', '-Wextra', '-Werror', ...platformArguments, '-I', nodeInclude, source, '-o', output],
  {
    cwd: repoRoot,
    stdio: 'inherit',
  },
);
