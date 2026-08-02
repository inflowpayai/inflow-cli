#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const version = '1.2.3';
const workspace = mkdtempSync(join(tmpdir(), 'inflow-native-release-'));
const baseline = join(workspace, 'baseline');
const verifier = resolve('scripts/verify-native-release-assets.mjs');
const assembler = resolve('scripts/assemble-native-release-assets.mjs');
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
  mkdirSync(baseline);
  for (const name of packages) {
    writeFileSync(join(baseline, name), name);
    writeFileSync(join(baseline, `${name}.sha256`), `${sha256(join(baseline, name))}  ${name}\n`);
  }
  const linuxPackages = packages.filter((name) => !name.includes('-darwin-')).sort();
  writeFileSync(
    join(baseline, 'SHA256SUMS'),
    `${linuxPackages.map((name) => `${sha256(join(baseline, name))}  ${name}`).join('\n')}\n`,
  );
  writeFileSync(join(baseline, 'SHA256SUMS.asc'), 'test signature');
  writeFileSync(join(baseline, 'inflow-linux-signing-key.asc'), 'test public key');
  writeFileSync(join(baseline, 'install.sh'), '#!/bin/sh\n');

  run(verifier, [baseline, version]);
  const assets = releaseAssets().map((name) => ({
    name,
    digest: `sha256:${sha256(join(baseline, name))}`,
  }));
  const releaseJson = join(workspace, 'release.json');
  writeFileSync(releaseJson, JSON.stringify({ assets }));
  run(verifier, [baseline, version, releaseJson]);

  const corrupt = scenario('corrupt');
  writeFileSync(join(corrupt, `${packages[0]}.sha256`), `invalid  ${packages[0]}\n`);
  reject('corrupt checksum', verifier, [corrupt, version]);

  const missing = scenario('missing');
  rmSync(join(missing, packages[0]));
  reject('missing asset', verifier, [missing, version]);

  const unexpected = scenario('unexpected');
  writeFileSync(join(unexpected, 'unexpected.zip'), 'unexpected');
  reject('unexpected asset', verifier, [unexpected, version]);

  const malformedJson = join(workspace, 'malformed.json');
  writeFileSync(malformedJson, JSON.stringify({ assets: {} }));
  reject('malformed release metadata', verifier, [baseline, version, malformedJson]);

  const wrongDigestJson = join(workspace, 'wrong-digest.json');
  writeFileSync(
    wrongDigestJson,
    JSON.stringify({
      assets: assets.map((asset, index) => (index === 0 ? { ...asset, digest: 'sha256:invalid' } : asset)),
    }),
  );
  reject('mismatched published digest', verifier, [baseline, version, wrongDigestJson]);

  const firstStage = join(workspace, 'first-stage');
  const secondStage = join(workspace, 'second-stage');
  mkdirSync(firstStage);
  mkdirSync(secondStage);
  writeFileSync(join(firstStage, 'duplicate.zip'), 'first');
  writeFileSync(join(secondStage, 'duplicate.zip'), 'second');
  reject('duplicate staged filename', assembler, [join(workspace, 'duplicate-output'), firstStage, secondStage]);

  const macStage = join(workspace, 'mac-stage');
  const linuxStage = join(workspace, 'linux-stage');
  mkdirSync(macStage);
  mkdirSync(linuxStage);
  for (const name of releaseAssets()) {
    cpSync(join(baseline, name), join(name.includes('darwin') ? macStage : linuxStage, name));
  }
  writeFileSync(join(macStage, 'inflow.rb'), 'cask');
  const assembled = join(workspace, 'assembled');
  run(assembler, [assembled, macStage, linuxStage]);
  run(verifier, [assembled, version]);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

process.stdout.write('Native release asset contract tests passed.\n');

function scenario(name) {
  const path = join(workspace, name);
  cpSync(baseline, path, { recursive: true });
  return path;
}

function releaseAssets() {
  return [
    ...packages.flatMap((name) => [name, `${name}.sha256`]),
    'SHA256SUMS',
    'SHA256SUMS.asc',
    'inflow-linux-signing-key.asc',
    'install.sh',
  ];
}

function run(script, args) {
  execFileSync(process.execPath, [script, ...args], { stdio: 'inherit' });
}

function reject(label, script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  if (result.status === 0) throw new Error(`The ${label} case was accepted.`);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
