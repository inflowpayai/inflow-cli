#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = resolve(process.env.INFLOW_WINDOWS_ARTIFACT_DIR ?? join(repoRoot, 'dist/windows'));
const version = packageVersion();
const publisher = requiredEnvironment('INFLOW_WINDOWS_SIGNING_SUBJECT');
const architectures = ['x64', 'arm64'];
const checksums = new Map(
  architectures.map((architecture) => {
    const msi = join(artifactRoot, `inflow-${version}-windows-${architecture}.msi`);
    if (!existsSync(msi)) throw new Error(`Windows installer is unavailable: ${msi}`);
    const checksum = sha256(msi);
    writeFileSync(`${msi}.sha256`, `${checksum}  ${msi.split(/[\\/]/u).at(-1)}\n`);
    return [architecture, checksum];
  }),
);

renderTemplate('packaging/windows/install.ps1.template', 'install.ps1');
const wingetRoot = join(artifactRoot, 'winget');
mkdirSync(wingetRoot, { recursive: true });
renderTemplate('packaging/windows/winget/installer.yaml.template', 'winget/InFlowPayAI.InFlow.installer.yaml');
renderTemplate('packaging/windows/winget/locale.en-US.yaml.template', 'winget/InFlowPayAI.InFlow.locale.en-US.yaml');
renderTemplate('packaging/windows/winget/version.yaml.template', 'winget/InFlowPayAI.InFlow.yaml');

process.stdout.write(`Rendered combined x64 and ARM64 Windows release metadata for version ${version}.\n`);

function renderTemplate(source, destination) {
  const content = readFileSync(join(repoRoot, source), 'utf8')
    .replaceAll('__INFLOW_VERSION__', version)
    .replaceAll('__INFLOW_MSI_SHA256_X64__', requiredChecksum('x64'))
    .replaceAll('__INFLOW_MSI_SHA256_X64_UPPER__', requiredChecksum('x64').toUpperCase())
    .replaceAll('__INFLOW_MSI_SHA256_ARM64__', requiredChecksum('arm64'))
    .replaceAll('__INFLOW_MSI_SHA256_ARM64_UPPER__', requiredChecksum('arm64').toUpperCase())
    .replaceAll('__INFLOW_WINDOWS_PUBLISHER__', publisher);
  writeFileSync(join(artifactRoot, destination), content);
}

function requiredChecksum(architecture) {
  const checksum = checksums.get(architecture);
  if (checksum === undefined) throw new Error(`Windows checksum is unavailable for ${architecture}.`);
  return checksum;
}

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

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
