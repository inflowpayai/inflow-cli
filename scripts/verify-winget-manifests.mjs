#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';

const manifestRoot = resolve(process.argv[2] ?? 'dist/windows/winget');
const expectedVersion = process.argv[3] ?? packageVersion();

if (expectedVersion === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(expectedVersion)) {
  throw new Error('A valid release version is required.');
}

const identifier = 'InFlowPayAI.InFlow';
const schemaVersion = '1.12.0';
const installer = load('InFlowPayAI.InFlow.installer.yaml', 'installer');
const locale = load('InFlowPayAI.InFlow.locale.en-US.yaml', 'defaultLocale');
const version = load('InFlowPayAI.InFlow.yaml', 'version');

for (const [name, manifest] of [
  ['installer', installer],
  ['default locale', locale],
  ['version', version],
]) {
  requireEqual(manifest.PackageIdentifier, identifier, `${name} package identifier`);
  requireEqual(manifest.PackageVersion, expectedVersion, `${name} package version`);
  requireEqual(manifest.ManifestVersion, schemaVersion, `${name} schema version`);
}

requireEqual(locale.PackageLocale, 'en-US', 'package locale');
requireEqual(version.DefaultLocale, 'en-US', 'default locale');
requireEqual(installer.InstallerType, 'wix', 'installer type');
requireEqual(installer.Scope, 'machine', 'installer scope');

if (!Array.isArray(installer.Installers) || installer.Installers.length !== 2) {
  throw new Error('The installer manifest must contain exactly x64 and ARM64 installers.');
}

const installers = new Map(installer.Installers.map((entry) => [entry.Architecture, entry]));
if (installers.size !== 2 || !installers.has('x64') || !installers.has('arm64')) {
  throw new Error('The installer manifest must contain exactly x64 and ARM64 installers.');
}

for (const architecture of ['x64', 'arm64']) {
  const entry = installers.get(architecture);
  const filename = `inflow-${expectedVersion}-windows-${architecture}.msi`;
  const expectedUrl = `https://github.com/inflowpayai/inflow-cli/releases/download/v${expectedVersion}/${filename}`;
  const msi = [join(manifestRoot, filename), join(dirname(manifestRoot), filename)].find(existsSync);
  if (msi === undefined) throw new Error(`Windows installer is unavailable: ${filename}.`);
  requireEqual(entry.InstallerUrl, expectedUrl, `${architecture} installer URL`);
  requireEqual(entry.InstallerSha256, sha256(msi).toUpperCase(), `${architecture} MSI hash`);
}

process.stdout.write(`Verified WinGet manifests for InFlow ${expectedVersion}.\n`);

function load(filename, type) {
  const content = readFileSync(join(manifestRoot, filename), 'utf8');
  const expectedSchema = `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.${schemaVersion}.schema.json`;
  requireEqual(content.split(/\r?\n/u, 1)[0], expectedSchema, `${type} schema declaration`);
  if (content.includes('__INFLOW_')) throw new Error(`${filename} contains an unresolved template placeholder.`);
  const manifest = parse(content);
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`${filename} is not a YAML object.`);
  }
  requireEqual(manifest.ManifestType, type, `${filename} manifest type`);
  return manifest;
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`Unexpected ${label}: ${String(actual)}; expected ${expected}.`);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function packageVersion() {
  const manifest = JSON.parse(readFileSync(resolve('packages/cli/package.json'), 'utf8'));
  if (typeof manifest.version !== 'string') throw new Error('CLI package version is missing.');
  return manifest.version;
}
