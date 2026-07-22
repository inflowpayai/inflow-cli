#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') {
  process.exit(0);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(repoRoot, 'packages/core/native/vault_peer_darwin.c');
const outputDirectory = join(repoRoot, 'packages/core/native/build');
const output = join(outputDirectory, 'vault_peer_darwin.node');
const nodeInclude = resolve(dirname(process.execPath), '../include/node');

mkdirSync(outputDirectory, { recursive: true });
execFileSync(
  'cc',
  [
    '-std=c11',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-dynamiclib',
    '-undefined',
    'dynamic_lookup',
    '-I',
    nodeInclude,
    source,
    '-o',
    output,
  ],
  { cwd: repoRoot, stdio: 'inherit' },
);
