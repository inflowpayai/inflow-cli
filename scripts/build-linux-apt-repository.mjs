#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = resolve(process.argv[2] ?? join(repoRoot, 'dist/linux/packages'));
const outputRoot = resolve(process.argv[3] ?? join(repoRoot, 'dist/linux/apt'));
const signingKey = requiredEnvironment('INFLOW_LINUX_SIGNING_KEY_ID');
const architectures = ['amd64', 'arm64'];
const distributionRoot = join(outputRoot, 'dists/stable');
const poolRoot = join(outputRoot, 'pool/main/i/inflow');
const overridePath = join(outputRoot, 'indices/override');

rmSync(outputRoot, { force: true, recursive: true });
mkdirSync(poolRoot, { recursive: true });
mkdirSync(dirname(overridePath), { recursive: true });
writeFileSync(overridePath, 'inflow optional utils\n');

const debianPackages = readdirSync(packageRoot)
  .filter((name) => name.endsWith('.deb'))
  .sort();
if (debianPackages.length !== architectures.length) {
  throw new Error(
    `Expected ${architectures.length.toString()} Debian packages, found ${debianPackages.length.toString()}.`,
  );
}
for (const name of debianPackages) copyFileSync(join(packageRoot, name), join(poolRoot, name));

for (const architecture of architectures) {
  const binaryRoot = join(distributionRoot, 'main', `binary-${architecture}`);
  mkdirSync(binaryRoot, { recursive: true });
  const packages = run(
    'dpkg-scanpackages',
    ['--arch', architecture, 'pool/main/i/inflow', 'indices/override'],
    outputRoot,
  );
  if (packages.length === 0) throw new Error(`APT metadata is empty for ${architecture}.`);
  writeFileSync(join(binaryRoot, 'Packages'), packages);
  writeFileSync(join(binaryRoot, 'Packages.gz'), gzipSync(packages, { level: 9 }));
}

const release = run('apt-ftparchive', ['release', 'dists/stable'], outputRoot);
writeFileSync(
  join(distributionRoot, 'Release'),
  [
    'Origin: InFlow',
    'Label: InFlow',
    'Suite: stable',
    'Codename: stable',
    `Architectures: ${architectures.join(' ')}`,
    'Components: main',
    'Description: InFlow signed package repository',
    release.toString().trimEnd(),
    '',
  ].join('\n'),
);

run('gpg', [
  '--batch',
  '--yes',
  '--digest-algo',
  'SHA256',
  '--local-user',
  signingKey,
  '--clearsign',
  '--output',
  join(distributionRoot, 'InRelease'),
  join(distributionRoot, 'Release'),
]);
run('gpg', [
  '--batch',
  '--yes',
  '--digest-algo',
  'SHA256',
  '--local-user',
  signingKey,
  '--detach-sign',
  '--output',
  join(distributionRoot, 'Release.gpg'),
  join(distributionRoot, 'Release'),
]);
writeFileSync(join(outputRoot, 'inflow-archive-keyring.gpg'), run('gpg', ['--batch', '--export', signingKey]));

process.stdout.write(`${outputRoot}\n`);

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function run(command, args, cwd = repoRoot) {
  return execFileSync(command, args, {
    cwd,
    encoding: command === 'gpg' && args.includes('--export') ? 'buffer' : null,
  });
}
