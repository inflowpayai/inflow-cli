#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = packageVersion();
const outPath = resolve(process.env.INFLOW_HOMEBREW_CASK_OUT ?? join(repoRoot, 'dist/homebrew/Casks/inflow.rb'));
const artifactPath = resolve(
  process.env.INFLOW_HOMEBREW_ARTIFACT ??
    join(repoRoot, `dist/macos/inflow-${version}-${process.platform}-${process.arch}.zip`),
);

if (!existsSync(artifactPath)) {
  throw new Error(`Homebrew artifact does not exist: ${artifactPath}`);
}

const currentArch = process.arch === 'arm64' ? 'arm' : process.arch === 'x64' ? 'intel' : undefined;
if (currentArch === undefined) {
  throw new Error(`Homebrew cask rendering does not support ${process.arch}.`);
}

const checksum = sha256(artifactPath);
const caskUrl =
  process.env.INFLOW_HOMEBREW_URL ??
  'https://github.com/inflowpayai/inflow-cli/releases/download/v#{version}/inflow-#{version}-darwin-arm64.zip';
const cask = renderSingleArchCask({ caskUrl, checksum, currentArch, version });

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, cask);
console.log(`Rendered ${outPath}`);

function renderSingleArchCask({ caskUrl, checksum, currentArch, version }) {
  const archRequirement = currentArch === 'arm' ? ':arm64' : ':x86_64';
  return `cask "inflow" do
  version "${escapeRuby(version)}"
  sha256 "${checksum}"

  url "${escapeRuby(caskUrl)}",
      verified: "github.com/inflowpayai/inflow-cli/"
  name "InFlow"
  desc "Agent enrollment and agentic payments from your machine"
  homepage "https://inflowcli.ai"

  depends_on macos: :ventura
  depends_on arch: ${archRequirement}

  binary "InFlow.app/Contents/MacOS/inflow", target: "inflow"
end
`;
}

function packageVersion() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'packages/cli/package.json'), 'utf8'));
  if (typeof pkg.version !== 'string') throw new Error('packages/cli/package.json is missing a string version.');
  return pkg.version;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function escapeRuby(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
