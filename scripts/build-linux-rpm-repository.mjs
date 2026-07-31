#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = resolve(process.argv[2] ?? join(repoRoot, 'dist/linux/packages'));
const outputRoot = resolve(process.argv[3] ?? join(repoRoot, 'dist/linux/rpm'));
const signingKey = requiredEnvironment('INFLOW_LINUX_SIGNING_KEY_ID');
const gpgHome = requiredEnvironment('GNUPGHOME');
const packagesRoot = join(outputRoot, 'packages');

rmSync(outputRoot, { force: true, recursive: true });
mkdirSync(packagesRoot, { recursive: true });

const rpmPackages = readdirSync(packageRoot)
  .filter((name) => name.endsWith('.rpm'))
  .sort();
if (rpmPackages.length !== 2) {
  throw new Error(`Expected 2 RPM packages, found ${rpmPackages.length.toString()}.`);
}

for (const name of rpmPackages) {
  const destination = join(packagesRoot, name);
  copyFileSync(join(packageRoot, name), destination);
  run('rpmsign', ['--addsign', '--define', `_gpg_name ${signingKey}`, '--define', `_gpg_path ${gpgHome}`, destination]);
}

run('createrepo_c', ['--checksum', 'sha256', outputRoot]);
const metadata = join(outputRoot, 'repodata/repomd.xml');
run('gpg', [
  '--armor',
  '--batch',
  '--yes',
  '--digest-algo',
  'SHA256',
  '--local-user',
  signingKey,
  '--detach-sign',
  '--output',
  `${metadata}.asc`,
  metadata,
]);
writeFileSync(join(outputRoot, 'inflow-signing-key.gpg'), run('gpg', ['--batch', '--export', signingKey]));
writeFileSync(join(outputRoot, 'inflow-signing-key.asc'), run('gpg', ['--armor', '--batch', '--export', signingKey]));

process.stdout.write(`${outputRoot}\n`);

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function run(command, args) {
  return execFileSync(command, args, { cwd: repoRoot });
}
