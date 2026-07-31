#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version;
const output = resolve(process.argv[2] ?? join(repoRoot, 'dist/linux/install.sh'));
const template = readFileSync(join(repoRoot, 'packaging/linux/install.sh.template'), 'utf8');
const signingFingerprint = requiredEnvironment('INFLOW_LINUX_SIGNING_FINGERPRINT').replaceAll(/\s/gu, '').toUpperCase();
if (!/^[0-9A-F]{40,64}$/u.test(signingFingerprint)) {
  throw new Error('INFLOW_LINUX_SIGNING_FINGERPRINT is invalid.');
}

mkdirSync(dirname(output), { recursive: true });
writeFileSync(
  output,
  template
    .replaceAll('__INFLOW_VERSION__', version)
    .replaceAll('__INFLOW_LINUX_SIGNING_FINGERPRINT__', signingFingerprint),
  { mode: 0o755 },
);
process.stdout.write(`${output}\n`);

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}
