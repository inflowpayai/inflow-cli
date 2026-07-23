#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromCli = createRequire(join(repoRoot, 'packages/cli/package.json'));
const requireFromCore = createRequire(join(repoRoot, 'packages/core/package.json'));
const version = packageVersion();
const architecture = linuxArchitecture();
const artifactRoot = resolve(process.env.INFLOW_LINUX_ARTIFACT_DIR ?? join(repoRoot, 'dist/linux'));
const packageName = `inflow-${version}-linux-${architecture}`;
const packageRoot = join(artifactRoot, packageName);
const executablePath = join(packageRoot, 'bin/inflow');
const runtimePath = join(packageRoot, 'lib/inflow');
const runtimeNodeModules = join(runtimePath, 'node_modules');
const buildRoot = join(artifactRoot, 'build');
const seaConfigPath = join(buildRoot, 'sea-config.json');
const seaBlobPath = join(buildRoot, 'inflow.sea.blob');
const seaMainPath = join(buildRoot, 'sea-main.cjs');
const archivePath = join(artifactRoot, `${packageName}.tar.gz`);

if (process.platform !== 'linux') {
  throw new Error('Linux packaging must run on Linux.');
}

if (!isAtLeastNodeVersion(process.versions.node, 24, 15, 0)) {
  throw new Error(`Linux packaging requires Node 24.15.0 or newer; current Node is ${process.versions.node}.`);
}

rmSync(artifactRoot, { force: true, recursive: true });
mkdirSync(buildRoot, { recursive: true });
mkdirSync(dirname(executablePath), { recursive: true });
mkdirSync(runtimePath, { recursive: true });

run('pnpm', ['--filter', '@inflowpayai/inflow-core', 'build']);
run(process.execPath, ['scripts/build-vault-peer-native.mjs']);
run('pnpm', ['--filter', '@inflowpayai/inflow', 'build:standalone']);

copyFileSync(join(repoRoot, 'packages/cli/dist/cli.standalone.mjs'), join(runtimePath, 'cli.standalone.mjs'));
copyArgon2Runtime();
copyMcpRuntime();
copyVaultPeerRuntime();
writeSeaMain();
writeFileSync(
  seaConfigPath,
  `${JSON.stringify(
    {
      disableExperimentalSEAWarning: true,
      main: seaMainPath,
      output: seaBlobPath,
    },
    null,
    2,
  )}\n`,
);
run(process.execPath, ['--experimental-sea-config', seaConfigPath]);
copyFileSync(process.execPath, executablePath);
run(resolvePostject(), [
  executablePath,
  'NODE_SEA_BLOB',
  seaBlobPath,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
]);
run('chmod', ['0755', executablePath]);
linkExecutable();
archive();

const checksum = sha256(archivePath);
writeFileSync(`${archivePath}.sha256`, `${checksum}  ${packageName}.tar.gz\n`);
writeFileSync(
  join(artifactRoot, 'manifest.json'),
  `${JSON.stringify(
    {
      arch: architecture,
      archive: archivePath,
      executable: executablePath,
      node: process.versions.node,
      platform: process.platform,
      sha256: checksum,
    },
    null,
    2,
  )}\n`,
);

console.log(`Built ${packageRoot}`);
console.log(`Packaged ${archivePath}`);

function copyArgon2Runtime() {
  const argon2Root = dirname(requireFromCore.resolve('@node-rs/argon2/package.json'));
  const requireFromArgon2 = createRequire(join(argon2Root, 'index.js'));
  const nativePackageName = `@node-rs/argon2-linux-${architecture}-gnu`;
  const nativeRoot = dirname(requireFromArgon2.resolve(`${nativePackageName}/package.json`));
  copyPackage(argon2Root, join(runtimeNodeModules, '@node-rs/argon2'));
  copyPackage(nativeRoot, join(runtimeNodeModules, nativePackageName));
  copyFileSync(
    join(nativeRoot, `argon2.linux-${architecture}-gnu.node`),
    join(runtimeNodeModules, '@node-rs/argon2', `argon2.linux-${architecture}-gnu.node`),
  );
}

function copyMcpRuntime() {
  const serverRoot = packageDirectoryRoot('@modelcontextprotocol/server', [
    () => nestedPackageRoot('incur', '@modelcontextprotocol/server'),
  ]);
  const zodRoot = dependencyPackageRoot('zod', requireFromCli);
  copyPackage(serverRoot, join(runtimeNodeModules, '@modelcontextprotocol/server'));
  copyPackage(zodRoot, join(runtimeNodeModules, 'zod'));
}

function copyVaultPeerRuntime() {
  const nativeRuntimePath = join(runtimePath, 'native');
  mkdirSync(nativeRuntimePath, { recursive: true });
  copyFileSync(
    join(repoRoot, 'packages/core/native/build/vault_peer_linux.node'),
    join(nativeRuntimePath, 'vault_peer_linux.node'),
  );
}

function linkExecutable() {
  const linkedPath = join(artifactRoot, 'bin/inflow');
  mkdirSync(dirname(linkedPath), { recursive: true });
  symlinkSync(`../../${packageName}/bin/inflow`, linkedPath);
}

function archive() {
  run('tar', ['-C', artifactRoot, '-czf', archivePath, packageName]);
}

function writeSeaMain() {
  writeFileSync(
    seaMainPath,
    `const { dirname, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const cli = resolve(dirname(process.execPath), '../lib/inflow/cli.standalone.mjs');
import(pathToFileURL(cli).href).catch((cause) => {
  const message = cause instanceof Error ? cause.stack ?? cause.message : String(cause);
  process.stderr.write(\`\${message}\\n\`);
  process.exit(1);
});
`,
  );
}

function copyPackage(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, {
    dereference: true,
    filter: (sourcePath) => !sourcePath.includes(`${source}/node_modules/`),
    recursive: true,
  });
}

function packageDirectoryRoot(packageName, fallbacks = []) {
  const candidate = join(repoRoot, 'packages/cli/node_modules', packageName);
  if (existsSync(join(candidate, 'package.json'))) return candidate;
  for (const fallback of fallbacks) {
    try {
      return fallback();
    } catch {
      continue;
    }
  }
  throw new Error(`Could not find package root for ${packageName}.`);
}

function dependencyPackageRoot(packageName, resolver) {
  return findPackageRoot(dirname(resolver.resolve(packageName)));
}

function nestedPackageRoot(parentPackageName, packageName) {
  const parentRoot = findPackageRoot(dirname(requireFromCli.resolve(parentPackageName)));
  return findPackageRoot(join(parentRoot, 'node_modules', packageName));
}

function findPackageRoot(startPath) {
  let current = startPath;
  while (current !== dirname(current)) {
    if (existsSync(join(current, 'package.json'))) return current;
    current = dirname(current);
  }
  throw new Error(`Could not find package root from ${startPath}.`);
}

function resolvePostject() {
  const bin = join(repoRoot, 'node_modules/.bin/postject');
  if (!existsSync(bin)) throw new Error('postject is not installed. Run pnpm install.');
  return bin;
}

function packageVersion() {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'packages/cli/package.json'), 'utf8'));
  if (typeof manifest.version !== 'string') throw new Error('CLI package version is missing.');
  return manifest.version;
}

function linuxArchitecture() {
  if (process.arch === 'x64' || process.arch === 'arm64') return process.arch;
  throw new Error(`Unsupported Linux architecture: ${process.arch}.`);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isAtLeastNodeVersion(value, major, minor, patch) {
  const [actualMajor = 0, actualMinor = 0, actualPatch = 0] = value.split('.').map(Number);
  if (actualMajor !== major) return actualMajor > major;
  if (actualMinor !== minor) return actualMinor > minor;
  return actualPatch >= patch;
}

function run(command, args) {
  execFileSync(command, args, { cwd: repoRoot, stdio: 'inherit' });
}
