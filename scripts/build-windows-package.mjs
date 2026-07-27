#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromCli = createRequire(join(repoRoot, 'packages/cli/package.json'));
const requireFromCore = createRequire(join(repoRoot, 'packages/core/package.json'));
const args = new Set(process.argv.slice(2));
const release = args.has('--release');
const signedDebug = args.has('--signed-debug');
const prepareExternalSigning = args.has('--prepare-external-signing');
const buildMsiFromPreparedPayload = args.has('--build-msi-from-prepared-payload');
const buildMsiFromSignedPayload = args.has('--build-msi-from-signed-payload');
const writeUnsignedReleaseMetadata = args.has('--write-unsigned-release-metadata');
const writeSignedReleaseMetadata = args.has('--write-signed-release-metadata');
const externalSigningPhases = [
  prepareExternalSigning,
  buildMsiFromPreparedPayload,
  buildMsiFromSignedPayload,
  writeUnsignedReleaseMetadata,
  writeSignedReleaseMetadata,
].filter(Boolean);
const version = packageVersion();
const architecture = windowsArchitecture(
  buildMsiFromPreparedPayload ||
    buildMsiFromSignedPayload ||
    writeUnsignedReleaseMetadata ||
    writeSignedReleaseMetadata,
);
const artifactRoot = resolve(process.env.INFLOW_WINDOWS_ARTIFACT_DIR ?? join(repoRoot, 'dist/windows'));
const payloadRoot = join(artifactRoot, 'payload');
const runtimePath = join(payloadRoot, 'runtime');
const runtimeNodeModules = join(runtimePath, 'node_modules');
const buildRoot = join(artifactRoot, 'build');
const executablePath = join(payloadRoot, 'inflow.exe');
const seaConfigPath = join(buildRoot, 'sea-config.json');
const seaBlobPath = join(buildRoot, 'inflow.sea.blob');
const seaMainPath = join(buildRoot, 'inflow-sea-main.cjs');
const packagedNodeLibraryPath = join(buildRoot, 'inflow-node.lib');
const msiPath = join(artifactRoot, `inflow-${version}-windows-${architecture}.msi`);

if (process.platform !== 'win32') throw new Error('Windows packaging must run on Windows.');
if (!isAtLeastNodeVersion(process.versions.node, 24, 15, 0)) {
  throw new Error(`Windows packaging requires Node 24.15.0 or newer; current Node is ${process.versions.node}.`);
}
if (release && signedDebug) throw new Error('Choose either release signing or development signing.');
if (externalSigningPhases.length > 1 || (externalSigningPhases.length === 1 && (release || signedDebug))) {
  throw new Error('Choose exactly one external-signing phase, release signing, or development signing.');
}

if (buildMsiFromPreparedPayload || buildMsiFromSignedPayload) {
  requirePreparedPayload();
  if (buildMsiFromSignedPayload) verifyAuthenticode(executablePath);
  buildMsi();
  const payloadState = buildMsiFromSignedPayload ? 'signed' : 'prepared';
  process.stdout.write(`Packaged unsigned ${msiPath} from the ${payloadState} executable payload.\n`);
} else if (writeUnsignedReleaseMetadata || writeSignedReleaseMetadata) {
  requirePreparedPayload();
  if (writeSignedReleaseMetadata) {
    verifyAuthenticode(executablePath);
    verifyAuthenticode(msiPath);
  } else if (!existsSync(msiPath)) {
    throw new Error(`Windows installer is unavailable: ${msiPath}`);
  }
  writeReleaseMetadata(writeSignedReleaseMetadata);
  const signatureState = writeSignedReleaseMetadata ? 'signed' : 'unsigned';
  process.stdout.write(`Rendered ${signatureState} Windows release metadata for ${msiPath}.\n`);
} else {
  buildExecutablePayload();
  if (prepareExternalSigning) {
    process.stdout.write(`Prepared unsigned ${executablePath} for external signing.\n`);
  } else {
    sign(executablePath);
    buildMsi();
    sign(msiPath);
    writeReleaseMetadata(release || signedDebug);
    process.stdout.write(`Packaged ${msiPath}\n`);
  }
}

function buildExecutablePayload() {
  rmSync(artifactRoot, { force: true, recursive: true });
  mkdirSync(buildRoot, { recursive: true });
  mkdirSync(runtimePath, { recursive: true });

  const tsupCli = join(repoRoot, 'node_modules/tsup/dist/cli-default.js');
  run(process.execPath, [tsupCli], { cwd: join(repoRoot, 'packages/core') });
  buildPackagedNodeImportLibrary();
  run(process.execPath, ['scripts/build-vault-peer-native.mjs'], {
    env: { INFLOW_NODE_LIBRARY: packagedNodeLibraryPath },
  });
  verifyPackagedNativeImports();
  run(process.execPath, [tsupCli, '--config', 'tsup.standalone.config.ts'], {
    cwd: join(repoRoot, 'packages/cli'),
  });
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
  removeExistingSignature(executablePath);
  run(process.execPath, [
    resolvePostject(),
    executablePath,
    'NODE_SEA_BLOB',
    seaBlobPath,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ]);
}

function buildPackagedNodeImportLibrary() {
  run('lib.exe', [
    '/nologo',
    `/def:${join(repoRoot, 'packaging/windows/inflow-node.def')}`,
    `/machine:${architecture}`,
    `/out:${packagedNodeLibraryPath}`,
  ]);
}

function verifyPackagedNativeImports() {
  const nativePath = join(repoRoot, 'packages/core/native/build/vault_peer_windows.node');
  const imports = execFileSync('dumpbin.exe', ['/imports', nativePath], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (!imports.includes('inflow.exe') || imports.includes('node.exe')) {
    throw new Error('Packaged Windows native module must import the InFlow executable host.');
  }
}

function copyArgon2Runtime() {
  const argon2Root = dirname(requireFromCore.resolve('@node-rs/argon2/package.json'));
  const requireFromArgon2 = createRequire(join(argon2Root, 'index.js'));
  const nativePackageName = `@node-rs/argon2-win32-${architecture}-msvc`;
  const nativeRoot = dirname(requireFromArgon2.resolve(`${nativePackageName}/package.json`));
  copyPackage(argon2Root, join(runtimeNodeModules, '@node-rs/argon2'));
  copyPackage(nativeRoot, join(runtimeNodeModules, nativePackageName));
  copyFileSync(
    join(nativeRoot, `argon2.win32-${architecture}-msvc.node`),
    join(runtimeNodeModules, '@node-rs/argon2', `argon2.win32-${architecture}-msvc.node`),
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
  const nativePath = join(payloadRoot, 'native');
  mkdirSync(nativePath, { recursive: true });
  copyFileSync(
    join(repoRoot, 'packages/core/native/build/vault_peer_windows.node'),
    join(nativePath, 'vault_peer_windows.node'),
  );
}

function writeSeaMain() {
  const cliSource = readFileSync(join(repoRoot, 'packages/cli/dist/cli.standalone.mjs')).toString('base64');
  const runtimeManifest = runtimeFiles().map((path) => [relative(payloadRoot, path), sha256(path)]);
  writeFileSync(
    seaMainPath,
    `const { createHash } = require('node:crypto');
const { lstatSync, readFileSync, realpathSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

const executablePath = realpathSync(process.execPath);
const payloadRoot = dirname(executablePath);
const manifest = new Map(${JSON.stringify(runtimeManifest)});

try {
  for (const [name, expectedHash] of manifest) {
    const path = join(payloadRoot, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) {
      throw new Error('unsafe runtime path');
    }
    const actualHash = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (actualHash !== expectedHash) throw new Error('runtime digest mismatch');
  }
} catch (cause) {
  const reason = cause instanceof Error ? cause.message : 'unknown integrity failure';
  process.stderr.write(\`InFlow runtime integrity verification failed: \${reason}.\\n\`);
  process.exit(1);
}

const cli = ${JSON.stringify(`data:text/javascript;base64,${cliSource}`)};
import(cli).catch((cause) => {
  const message = cause instanceof Error ? cause.stack ?? cause.message : String(cause);
  process.stderr.write(\`\${message}\\n\`);
  process.exit(1);
});
`,
  );
}

function buildMsi() {
  const wix = process.env.INFLOW_WIX_PATH ?? 'wix.exe';
  run(wix, [
    'build',
    '-arch',
    architecture,
    '-d',
    `Version=${version}`,
    '-d',
    `Payload=${payloadRoot}`,
    '-o',
    msiPath,
    join(repoRoot, 'packaging/windows/inflow.wxs'),
  ]);
}

function sign(path) {
  if (!release && !signedDebug) return;
  const signtool = requiredEnvironment('INFLOW_SIGNTOOL_PATH');
  const subject = requiredEnvironment('INFLOW_WINDOWS_SIGNING_SUBJECT');
  const signingArguments = ['sign', '/fd', 'SHA256', '/n', subject];
  if (signedDebug) signingArguments.push('/sm');
  if (release) {
    signingArguments.push('/tr', requiredEnvironment('INFLOW_WINDOWS_TIMESTAMP_URL'), '/td', 'SHA256');
  }
  signingArguments.push(path);
  run(signtool, signingArguments);
  run(signtool, ['verify', '/pa', '/v', path]);
}

function verifyAuthenticode(path) {
  if (!existsSync(path)) throw new Error(`Signed Windows artifact is unavailable: ${path}`);
  const signtool = process.env.INFLOW_SIGNTOOL_PATH ?? 'signtool.exe';
  run(signtool, ['verify', '/pa', '/v', path]);
}

function removeExistingSignature(path) {
  const signtool = process.env.INFLOW_SIGNTOOL_PATH ?? 'signtool.exe';
  run(signtool, ['remove', '/s', path]);
}

function writeReleaseMetadata(signed) {
  const checksum = sha256(msiPath);
  writeFileSync(`${msiPath}.sha256`, `${checksum}  ${msiPath.split(/[\\/]/u).at(-1)}\n`);
  writeFileSync(
    join(artifactRoot, 'manifest.json'),
    `${JSON.stringify(
      {
        arch: architecture,
        msi: msiPath,
        node: process.versions.node,
        platform: process.platform,
        sha256: checksum,
        signed,
        version,
      },
      null,
      2,
    )}\n`,
  );
}

function runtimeFiles(root = runtimePath) {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? runtimeFiles(path) : entry.isFile() ? [path] : [];
    })
    .sort();
}

function copyPackage(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, {
    dereference: true,
    filter: (sourcePath) => !sourcePath.includes(`${source}${process.platform === 'win32' ? '\\' : '/'}node_modules`),
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
  const bin = join(repoRoot, 'node_modules/postject/dist/cli.js');
  if (!existsSync(bin)) throw new Error('postject is not installed. Run pnpm install.');
  return bin;
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function packageVersion() {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'packages/cli/package.json'), 'utf8'));
  if (typeof manifest.version !== 'string') throw new Error('CLI package version is missing.');
  return manifest.version;
}

function windowsArchitecture(allowTargetOverride) {
  const target = allowTargetOverride ? process.env.INFLOW_WINDOWS_TARGET_ARCH : undefined;
  if (target === 'x64' || target === 'arm64') return target;
  if (target !== undefined) throw new Error(`Unsupported Windows target architecture: ${target}.`);
  if (process.arch === 'x64' || process.arch === 'arm64') return process.arch;
  throw new Error(`Unsupported Windows architecture: ${process.arch}.`);
}

function requirePreparedPayload() {
  if (!existsSync(executablePath) || !existsSync(runtimePath)) {
    throw new Error(`Prepared Windows payload is unavailable under ${payloadRoot}.`);
  }
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

function run(command, commandArguments, options = {}) {
  execFileSync(command, commandArguments, {
    cwd: options.cwd ?? repoRoot,
    env: { ...process.env, ...options.env },
    stdio: 'inherit',
  });
}
