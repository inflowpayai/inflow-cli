import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');

interface CliManifest {
  name: string;
  version: string;
}

const manifest = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf-8')) as CliManifest;
const buildId = computeBuildId();
const vaultPeerNative = requiredDevelopmentVaultPeerNative();

const skillsDir = resolve(repoRoot, 'skills');

const bootstrapPath = resolve(skillsDir, 'skill.md');
const bootstrapBody = extractSkillBody(readFileSync(bootstrapPath, 'utf-8'), bootstrapPath);

const skillBodies: Record<string, string> = {};
const skillEntries = readdirSync(skillsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
for (const entry of skillEntries) {
  if (!entry.isDirectory()) continue;
  const skillPath = resolve(skillsDir, entry.name, 'SKILL.md');
  if (!existsSync(skillPath)) continue;
  skillBodies[entry.name] = extractSkillBody(readFileSync(skillPath, 'utf-8'), skillPath);
}

function extractSkillBody(source: string, path: string): string {
  if (!source.startsWith('---\n') && !source.startsWith('---\r\n')) {
    return source.trimStart();
  }
  const closer = source.indexOf('\n---', 4);
  if (closer === -1) {
    throw new Error(`tsup.config.ts: SKILL.md at ${path} starts with frontmatter but has no closing '---'`);
  }
  const afterCloser = source.indexOf('\n', closer + 4);
  return (afterCloser === -1 ? '' : source.slice(afterCloser + 1)).trimStart();
}

const reactDevtoolsAlias = resolve(here, 'src/stubs/react-devtools-core.ts');
const BUNDLE_BANNER = [
  '#!/usr/bin/env node',
  "import { createRequire as __createRequire } from 'node:module';",
  'const require = __createRequire(import.meta.url);',
].join('\n');

export default defineConfig({
  banner: { js: BUNDLE_BANNER },
  clean: true,
  define: {
    __BOOTSTRAP_BODY__: JSON.stringify(bootstrapBody),
    __CLI_BUILD_ID__: JSON.stringify(buildId),
    __CLI_NAME__: JSON.stringify(manifest.name),
    __CLI_VERSION__: JSON.stringify(manifest.version),
    __SKILL_BODIES__: JSON.stringify(skillBodies),
    __VAULT_PEER_NATIVE_RELATIVE_PATH__: JSON.stringify(vaultPeerNative.relativePath),
    __VAULT_PEER_NATIVE_SHA256__: JSON.stringify(vaultPeerNative.sha256),
  },
  dts: true,
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias ?? {}),
      'react-devtools-core': reactDevtoolsAlias,
    };
  },
  external: ['@node-rs/argon2'],
  entry: { cli: 'src/cli.tsx', 'npm-shim': 'src/npm-shim.ts' },
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  splitting: false,
  sourcemap: false,
  target: 'node24',
});

function computeBuildId(): string {
  const hash = createHash('sha256');
  for (const filePath of buildIdentityFiles()) {
    hash.update(relative(repoRoot, filePath));
    hash.update('\0');
    hash.update(readFileSync(filePath));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function requiredDevelopmentVaultPeerNative(): { relativePath: string; sha256: string } {
  const platformName = process.platform === 'win32' ? 'windows' : process.platform;
  const nativePath = resolve(repoRoot, `packages/core/native/build/vault_peer_${platformName}.node`);
  if (!existsSync(nativePath)) {
    throw new Error(
      `Native vault peer verifier is missing at ${nativePath}. Run node scripts/build-vault-peer-native.mjs first.`,
    );
  }
  return {
    relativePath: `../../core/native/build/vault_peer_${platformName}.node`,
    sha256: createHash('sha256').update(readFileSync(nativePath)).digest('hex'),
  };
}

function buildIdentityFiles(): string[] {
  return [
    resolve(repoRoot, 'package.json'),
    resolve(repoRoot, 'pnpm-lock.yaml'),
    resolve(repoRoot, 'packages/core/package.json'),
    resolve(repoRoot, 'packages/cli/package.json'),
    resolve(repoRoot, 'packages/cli/tsup.config.ts'),
    resolve(repoRoot, 'packages/cli/tsup.standalone.config.ts'),
    resolve(repoRoot, 'patches/@apidevtools__json-schema-ref-parser@15.5.2.patch'),
    resolve(repoRoot, 'patches/incur@0.4.19.patch'),
    ...existingSourceFiles(resolve(repoRoot, 'packages/core/native')),
    ...sourceFiles(resolve(repoRoot, 'packages/core/src')),
    ...sourceFiles(resolve(repoRoot, 'packages/cli/src')),
    ...sourceFiles(resolve(repoRoot, 'skills')),
  ].sort();
}

function existingSourceFiles(root: string): string[] {
  return existsSync(root) ? sourceFiles(root) : [];
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = resolve(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(entryPath));
      continue;
    }
    if (entry.isFile()) out.push(entryPath);
  }
  return out;
}
