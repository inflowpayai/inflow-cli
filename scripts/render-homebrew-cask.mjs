#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = packageVersion();
const outPath = resolve(process.env.INFLOW_HOMEBREW_CASK_OUT ?? join(repoRoot, 'dist/homebrew/Casks/inflow.rb'));
const arm64ArtifactPath = resolve(
  process.env.INFLOW_HOMEBREW_ARM64_ARTIFACT ?? join(repoRoot, `dist/macos/inflow-${version}-darwin-arm64.zip`),
);
const x64ArtifactPath = resolve(
  process.env.INFLOW_HOMEBREW_X64_ARTIFACT ?? join(repoRoot, `dist/macos/inflow-${version}-darwin-x64.zip`),
);

for (const path of [arm64ArtifactPath, x64ArtifactPath]) {
  if (!existsSync(path)) {
    throw new Error(`Homebrew artifact does not exist: ${path}`);
  }
}

const arm64Checksum = sha256(arm64ArtifactPath);
const x64Checksum = sha256(x64ArtifactPath);
const caskUrl =
  process.env.INFLOW_HOMEBREW_URL ??
  'https://github.com/inflowpayai/inflow-cli/releases/download/v#{version}/inflow-#{version}-darwin-#{arch}.zip';
const cask = renderCask({ arm64Checksum, caskUrl, version, x64Checksum });

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, cask);
console.log(`Rendered ${outPath}`);

function renderCask({ arm64Checksum, caskUrl, version, x64Checksum }) {
  return `cask "inflow" do
  version "${escapeRuby(version)}"
  arch arm: "arm64", intel: "x64"

  sha256 arm:   "${arm64Checksum}",
         intel: "${x64Checksum}"

  url "${escapeRuby(caskUrl)}",
      verified: "github.com/inflowpayai/inflow-cli/"
  name "InFlow"
  desc "Agent enrollment and agentic payments from your machine"
  homepage "https://inflowcli.ai"

  depends_on macos: :ventura

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
