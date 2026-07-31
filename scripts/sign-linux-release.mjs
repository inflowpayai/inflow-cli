#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = resolve(process.argv[2] ?? join(repoRoot, 'dist/linux/release'));
const signingKey = requiredEnvironment('INFLOW_LINUX_SIGNING_KEY_ID');
const expectedFingerprint = normalizedFingerprint(requiredEnvironment('INFLOW_LINUX_SIGNING_FINGERPRINT'));
const version = packageVersion();
const expectedAssets = [
  `inflow-${version}-linux-arm64.tar.gz`,
  `inflow-${version}-linux-x64.tar.gz`,
  `inflow-${version}-1.aarch64.rpm`,
  `inflow-${version}-1.x86_64.rpm`,
  `inflow_${version}_amd64.deb`,
  `inflow_${version}_arm64.deb`,
];

for (const name of expectedAssets) {
  const asset = join(artifactRoot, name);
  if (!existsSync(asset)) throw new Error(`Linux release asset is unavailable: ${asset}`);
}
const unexpectedPackages = readdirSync(artifactRoot)
  .filter((name) => /\.(?:deb|rpm|tar\.gz)$/u.test(name) && !expectedAssets.includes(name))
  .sort();
if (unexpectedPackages.length > 0) {
  throw new Error(`Unexpected Linux release assets: ${unexpectedPackages.join(', ')}`);
}

const actualFingerprint = normalizedFingerprint(
  runText('gpg', ['--batch', '--with-colons', '--fingerprint', signingKey])
    .split('\n')
    .find((line) => line.startsWith('fpr:'))
    ?.split(':')[9] ?? '',
);
if (actualFingerprint !== expectedFingerprint) {
  throw new Error(
    `Linux signing-key fingerprint mismatch: expected ${expectedFingerprint}, received ${actualFingerprint}`,
  );
}

for (const name of expectedAssets.filter((asset) => asset.endsWith('.rpm'))) {
  run('rpmsign', [
    '--addsign',
    '--define',
    `_gpg_name ${signingKey}`,
    '--define',
    `_gpg_path ${requiredEnvironment('GNUPGHOME')}`,
    join(artifactRoot, name),
  ]);
}

const checksums = expectedAssets
  .map((name) => `${sha256(join(artifactRoot, name))}  ${name}`)
  .sort()
  .join('\n');
writeFileSync(join(artifactRoot, 'SHA256SUMS'), `${checksums}\n`);
for (const line of checksums.split('\n')) {
  const [checksum, name] = line.split('  ');
  if (checksum === undefined || name === undefined) throw new Error('Linux release checksum generation failed.');
  writeFileSync(join(artifactRoot, `${name}.sha256`), `${checksum}  ${name}\n`);
}

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
  join(artifactRoot, 'SHA256SUMS.asc'),
  join(artifactRoot, 'SHA256SUMS'),
]);
writeFileSync(
  join(artifactRoot, 'inflow-linux-signing-key.asc'),
  runBuffer('gpg', ['--armor', '--batch', '--export', signingKey]),
);

process.stdout.write(`Signed Linux release assets with ${actualFingerprint}.\n`);

function packageVersion() {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'packages/cli/package.json'), 'utf8'));
  if (typeof manifest.version !== 'string') throw new Error('CLI package version is missing.');
  return manifest.version;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function normalizedFingerprint(value) {
  const normalized = value.replaceAll(/\s/gu, '').toUpperCase();
  if (!/^[0-9A-F]{40,64}$/u.test(normalized)) throw new Error('Linux signing-key fingerprint is invalid.');
  return normalized;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function run(command, args) {
  execFileSync(command, args, { cwd: repoRoot, stdio: 'inherit' });
}

function runBuffer(command, args) {
  return execFileSync(command, args, { cwd: repoRoot });
}

function runText(command, args) {
  return execFileSync(command, args, { cwd: repoRoot, encoding: 'utf8' });
}
