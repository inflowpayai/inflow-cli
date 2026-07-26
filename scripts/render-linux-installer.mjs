#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
const output = resolve(process.argv[2] ?? join(repoRoot, 'dist/linux/install.sh'));
const template = readFileSync(join(repoRoot, 'packaging/linux/install.sh.template'), 'utf8');

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, template.replaceAll('__INFLOW_VERSION__', version), { mode: 0o755 });
process.stdout.write(`${output}\n`);
