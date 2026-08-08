#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? 'dist/native/assets');
const version = process.argv[3];
const releaseJson = process.argv[4];

if (version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
  throw new Error('A valid release version is required.');
}

const packages = [
  `inflow-${version}-darwin-arm64.zip`,
  `inflow-${version}-darwin-x64.zip`,
  `inflow-${version}-windows-arm64.msi`,
  `inflow-${version}-windows-x64.msi`,
  `inflow-${version}-linux-arm64.tar.gz`,
  `inflow-${version}-linux-x64.tar.gz`,
  `inflow-${version}-1.aarch64.rpm`,
  `inflow-${version}-1.x86_64.rpm`,
  `inflow_${version}_amd64.deb`,
  `inflow_${version}_arm64.deb`,
];
const expected = [
  ...packages.flatMap((name) => [name, `${name}.sha256`]),
  'SHA256SUMS',
  'SHA256SUMS.asc',
  'inflow-linux-signing-key.asc',
  'InFlowPayAI.InFlow.installer.yaml',
  'InFlowPayAI.InFlow.locale.en-US.yaml',
  'InFlowPayAI.InFlow.yaml',
  'install.ps1',
  'install.sh',
].sort();
const actual = readdirSync(root)
  .filter((name) => statSync(join(root, name)).isFile())
  .sort();

if (actual.join('\n') !== expected.join('\n')) {
  throw new Error(
    `Native release asset inventory mismatch.\nExpected:\n${expected.join('\n')}\nActual:\n${actual.join('\n')}`,
  );
}

for (const name of packages) {
  const digest = sha256(join(root, name));
  const checksum = readFileSync(join(root, `${name}.sha256`), 'utf8').trim();
  if (checksum !== `${digest}  ${name}`) throw new Error(`Checksum mismatch for ${name}.`);
}

const linuxPackages = packages.filter((name) => !name.includes('-darwin-') && !name.includes('-windows-')).sort();
const sums = readFileSync(join(root, 'SHA256SUMS'), 'utf8').trim().split('\n').sort();
const expectedSums = linuxPackages.map((name) => `${sha256(join(root, name))}  ${name}`).sort();
if (sums.join('\n') !== expectedSums.join('\n')) throw new Error('SHA256SUMS does not match the Linux packages.');

if (releaseJson !== undefined) {
  if (!existsSync(releaseJson)) throw new Error(`Release metadata is unavailable: ${releaseJson}`);
  const release = JSON.parse(readFileSync(releaseJson, 'utf8'));
  if (!Array.isArray(release.assets)) throw new Error('Release metadata does not contain assets.');
  const remote = release.assets
    .map((asset) => ({ name: asset.name, digest: asset.digest }))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  if (remote.map(({ name }) => name).join('\n') !== expected.join('\n')) {
    throw new Error('Published release asset inventory mismatch.');
  }
  for (const asset of remote) {
    const expectedDigest = `sha256:${sha256(join(root, basename(asset.name)))}`;
    if (asset.digest !== expectedDigest) throw new Error(`Published digest mismatch for ${asset.name}.`);
  }
}

process.stdout.write(`Verified ${expected.length} native release assets for ${version}.\n`);

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
