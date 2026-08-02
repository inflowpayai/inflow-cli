#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const version = '1.2.3';
const root = mkdtempSync(join(tmpdir(), 'inflow-native-release-'));
const releaseJson = `${root}.json`;
const packages = [
  `inflow-${version}-darwin-arm64.zip`,
  `inflow-${version}-darwin-x64.zip`,
  `inflow-${version}-linux-arm64.tar.gz`,
  `inflow-${version}-linux-x64.tar.gz`,
  `inflow-${version}-1.aarch64.rpm`,
  `inflow-${version}-1.x86_64.rpm`,
  `inflow_${version}_amd64.deb`,
  `inflow_${version}_arm64.deb`,
];

try {
  for (const name of packages) {
    writeFileSync(join(root, name), name);
    writeFileSync(join(root, `${name}.sha256`), `${sha256(join(root, name))}  ${name}\n`);
  }
  const linuxPackages = packages.filter((name) => !name.includes('-darwin-')).sort();
  writeFileSync(
    join(root, 'SHA256SUMS'),
    `${linuxPackages.map((name) => `${sha256(join(root, name))}  ${name}`).join('\n')}\n`,
  );
  writeFileSync(join(root, 'SHA256SUMS.asc'), 'test signature');
  writeFileSync(join(root, 'inflow-linux-signing-key.asc'), 'test public key');
  writeFileSync(join(root, 'install.sh'), '#!/bin/sh\n');

  const verifier = resolve('scripts/verify-native-release-assets.mjs');
  execFileSync(process.execPath, [verifier, root, version], { stdio: 'inherit' });
  const assets = [
    ...packages.flatMap((name) => [name, `${name}.sha256`]),
    'SHA256SUMS',
    'SHA256SUMS.asc',
    'inflow-linux-signing-key.asc',
    'install.sh',
  ].map((name) => ({ name, digest: `sha256:${sha256(join(root, name))}` }));
  writeFileSync(releaseJson, JSON.stringify({ assets }));
  execFileSync(process.execPath, [verifier, root, version, releaseJson], { stdio: 'inherit' });

  writeFileSync(join(root, `${packages[0]}.sha256`), `invalid  ${packages[0]}\n`);
  const rejected = spawnSync(process.execPath, [verifier, root, version], { stdio: 'ignore' });
  if (rejected.status === 0) throw new Error('The verifier accepted a corrupt checksum.');
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(releaseJson, { force: true });
}

process.stdout.write('Native release asset contract tests passed.\n');

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
