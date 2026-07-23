#!/usr/bin/env node
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requireFromCli = createRequire(join(repoRoot, 'packages/cli/package.json'));
const requireFromCore = createRequire(join(repoRoot, 'packages/core/package.json'));
const args = new Set(process.argv.slice(2));
const release = args.has('--release');
const signedDebug = args.has('--signed-debug');
const skipNotarize = args.has('--skip-notarize') || process.env.INFLOW_SKIP_NOTARIZATION === '1';
const identity = resolveCodesignIdentity({ release, signedDebug });
const timestampMode = process.env.INFLOW_CODESIGN_TIMESTAMP ?? 'default';
const notaryProfile = process.env.INFLOW_NOTARY_PROFILE ?? 'inflow-notary';
const packageName = 'InFlow';
const version = packageVersion();
const bundleIdentifier = process.env.INFLOW_BUNDLE_IDENTIFIER ?? 'ai.inflowpay.cli';
const artifactRoot = resolve(process.env.INFLOW_MACOS_ARTIFACT_DIR ?? join(repoRoot, 'dist/macos'));
const buildRoot = join(artifactRoot, 'build');
const appPath = join(artifactRoot, `${packageName}.app`);
const executablePath = join(appPath, 'Contents/MacOS/inflow');
const linkedExecutablePath = join(artifactRoot, 'bin/inflow');
const resourcesPath = join(appPath, 'Contents/Resources');
const resourceNodeModules = join(resourcesPath, 'app/node_modules');
const entitlementsPath = join(buildRoot, 'entitlements.plist');
const seaConfigPath = join(buildRoot, 'sea-config.json');
const seaBlobPath = join(buildRoot, 'inflow.sea.blob');
const seaMainPath = join(buildRoot, 'sea-main.cjs');
const standaloneBundlePath = join(resourcesPath, 'app/cli.standalone.mjs');
const nativeRuntimePath = join(resourcesPath, 'app/native');
const zipPath = join(artifactRoot, `inflow-${version}-${process.platform}-${process.arch}.zip`);
const nodeVersion = process.versions.node;

if (process.platform !== 'darwin') {
  throw new Error('macOS application packaging must run on macOS.');
}

if (release && !isAtLeastNodeVersion(nodeVersion, 24, 15, 0)) {
  throw new Error(`release packaging requires Node 24.15.0 or newer; current Node is ${nodeVersion}.`);
}

if (release && skipNotarize) {
  throw new Error('release packaging requires notarization.');
}

if (release && timestampMode === 'none') {
  throw new Error('release packaging requires codesign timestamping.');
}

rmSync(artifactRoot, { force: true, recursive: true });
mkdirSync(buildRoot, { recursive: true });
mkdirSync(join(appPath, 'Contents/MacOS'), { recursive: true });
mkdirSync(resourcesPath, { recursive: true });

run('pnpm', ['--filter', '@inflowpayai/inflow-core', 'build']);
run(process.execPath, ['scripts/build-vault-peer-native.mjs']);
run('pnpm', ['--filter', '@inflowpayai/inflow', 'build:standalone']);

mkdirSync(dirname(standaloneBundlePath), { recursive: true });
copyFileSync(join(repoRoot, 'packages/cli/dist/cli.standalone.mjs'), standaloneBundlePath);
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
run('codesign', ['--remove-signature', executablePath], { optional: true });
run(resolvePostject(), [
  executablePath,
  'NODE_SEA_BLOB',
  seaBlobPath,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  '--macho-segment-name',
  'NODE_SEA',
]);

writeInfoPlist();
writeEntitlements();
copyArgon2Runtime();
copyMcpRuntime();
copyVaultPeerRuntime();
signNestedCode();
signExecutable();
verifySignature({ assessGatekeeper: false, gatekeeperOptional: true });
linkExecutable();
zipArtifact();

if (!skipNotarize) {
  notarize();
  staple();
  verifySignature({ assessGatekeeper: true, gatekeeperOptional: false });
}

writeFileSync(
  join(artifactRoot, 'manifest.json'),
  `${JSON.stringify(
    {
      app: appPath,
      arch: process.arch,
      bundleIdentifier,
      executable: executablePath,
      identity,
      linkedExecutable: linkedExecutablePath,
      node: nodeVersion,
      notarized: !skipNotarize,
      platform: process.platform,
      zip: zipPath,
    },
    null,
    2,
  )}\n`,
);

console.log(`Built ${appPath}`);
console.log(`Packaged ${zipPath}`);

function copyArgon2Runtime() {
  const argon2Root = dirname(requireFromCore.resolve('@node-rs/argon2/package.json'));
  const requireFromArgon2 = createRequire(join(argon2Root, 'index.js'));
  const nativePackageName = `@node-rs/argon2-darwin-${process.arch}`;
  const nativeRoot = dirname(requireFromArgon2.resolve(`${nativePackageName}/package.json`));
  copyPackage(argon2Root, join(resourceNodeModules, '@node-rs/argon2'));
  copyPackage(nativeRoot, join(resourceNodeModules, nativePackageName));
  copyFileSync(
    join(nativeRoot, `argon2.darwin-${process.arch}.node`),
    join(resourceNodeModules, '@node-rs/argon2', `argon2.darwin-${process.arch}.node`),
  );
}

function copyMcpRuntime() {
  const serverRoot = packageDirectoryRoot('@modelcontextprotocol/server', [
    () => nestedPackageRoot('incur', '@modelcontextprotocol/server'),
  ]);
  const zodRoot = packageRoot('zod', requireFromCli);
  copyPackage(serverRoot, join(resourceNodeModules, '@modelcontextprotocol/server'));
  copyPackage(zodRoot, join(resourceNodeModules, 'zod'));
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

function copyVaultPeerRuntime() {
  mkdirSync(nativeRuntimePath, { recursive: true });
  copyFileSync(
    join(repoRoot, 'packages/core/native/build/vault_peer_darwin.node'),
    join(nativeRuntimePath, 'vault_peer_darwin.node'),
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

function packageRoot(packageName, resolver, fallbacks = []) {
  try {
    return findPackageRoot(dirname(resolver.resolve(packageName)));
  } catch (cause) {
    for (const fallback of fallbacks) {
      try {
        return fallback();
      } catch {
        continue;
      }
    }
    throw cause;
  }
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

function signNestedCode() {
  for (const file of listFiles(appPath)) {
    if (file.endsWith('.node') || isMachO(file)) {
      run('codesign', ['--force', '--sign', identity, ...timestampArgs(), ...runtimeArgs(), file]);
    }
  }
}

function signExecutable() {
  run('codesign', [
    '--force',
    '--sign',
    identity,
    ...timestampArgs(),
    ...runtimeArgs(),
    '--entitlements',
    entitlementsPath,
    appPath,
  ]);
}

function timestampArgs() {
  if (timestampMode === 'none') return ['--timestamp=none'];
  return identity === '-' ? ['--timestamp=none'] : ['--timestamp'];
}

function runtimeArgs() {
  return identity === '-' ? [] : ['--options', 'runtime'];
}

function verifySignature(options = { assessGatekeeper: true, gatekeeperOptional: false }) {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  if (identity !== '-' && options.assessGatekeeper) {
    run('spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath], {
      optional: options.gatekeeperOptional,
    });
  }
}

function linkExecutable() {
  mkdirSync(dirname(linkedExecutablePath), { recursive: true });
  rmSync(linkedExecutablePath, { force: true });
  symlinkSync('../InFlow.app/Contents/MacOS/inflow', linkedExecutablePath);
}

function zipArtifact() {
  rmSync(zipPath, { force: true });
  run('ditto', ['-c', '-k', '--keepParent', appPath, zipPath]);
}

function notarize() {
  run('xcrun', ['notarytool', 'submit', zipPath, '--keychain-profile', notaryProfile, '--wait']);
}

function staple() {
  run('xcrun', ['stapler', 'staple', appPath]);
  run('xcrun', ['stapler', 'validate', appPath]);
}

function writeEntitlements() {
  writeFileSync(
    entitlementsPath,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
</dict>
</plist>
`,
  );
}

function writeSeaMain() {
  writeFileSync(
    seaMainPath,
    `const { dirname, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const cli = resolve(dirname(process.execPath), '../Resources/app/cli.standalone.mjs');
import(pathToFileURL(cli).href).catch((cause) => {
  const message = cause instanceof Error ? cause.stack ?? cause.message : String(cause);
  process.stderr.write(\`\${message}\\n\`);
  process.exit(1);
});
`,
  );
}

function writeInfoPlist() {
  writeFileSync(
    join(appPath, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>InFlow</string>
  <key>CFBundleExecutable</key>
  <string>inflow</string>
  <key>CFBundleIdentifier</key>
  <string>${escapePlist(bundleIdentifier)}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>InFlow</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${escapePlist(version)}</string>
  <key>CFBundleVersion</key>
  <string>${escapePlist(version)}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
</dict>
</plist>
`,
  );
}

function packageVersion() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'packages/cli/package.json'), 'utf8'));
  if (typeof pkg.version !== 'string') throw new Error('packages/cli/package.json is missing a string version.');
  return pkg.version;
}

function resolvePostject() {
  const bin = join(repoRoot, 'node_modules/.bin/postject');
  if (!existsSync(bin)) throw new Error('postject is not installed. Run pnpm install.');
  return bin;
}

function listFiles(root) {
  const entries = readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const file = join(root, entry.name);
    if (entry.isDirectory()) return listFiles(file);
    if (entry.isFile()) return [file];
    return [];
  });
}

function isMachO(file) {
  if (file === executablePath) return false;
  const stat = statSync(file);
  if (stat.size < 4) return false;
  const header = readFileSync(file).subarray(0, 4);
  const magic = header.readUInt32BE(0);
  return magic === 0xcafebabe || magic === 0xcffaedfe || magic === 0xfeedfacf || magic === 0xfeedface;
}

function escapePlist(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function isAtLeastNodeVersion(version, major, minor, patch) {
  const [actualMajor = 0, actualMinor = 0, actualPatch = 0] = version
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  if (actualMajor !== major) return actualMajor > major;
  if (actualMinor !== minor) return actualMinor > minor;
  return actualPatch >= patch;
}

function resolveCodesignIdentity(options) {
  const configured = process.env.INFLOW_CODESIGN_IDENTITY;
  if (configured !== undefined) return configured;
  if (!options.release && !options.signedDebug) return '-';
  const identities = discoverDeveloperIdApplicationIdentities();
  if (identities.length === 1) return identities[0];
  if (identities.length === 0) {
    throw new Error('signed macOS packaging requires one visible Developer ID Application codesigning identity.');
  }
  throw new Error(
    [
      'signed macOS packaging found multiple Developer ID Application identities.',
      'Set INFLOW_CODESIGN_IDENTITY to one of:',
      ...identities.map((identityName) => `- ${identityName}`),
    ].join('\n'),
  );
}

function discoverDeveloperIdApplicationIdentities() {
  const output = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output
    .split('\n')
    .map((line) => line.match(/"([^"]+)"/)?.[1])
    .filter((identityName) => identityName?.startsWith('Developer ID Application:'));
}

function run(command, commandArgs, options = {}) {
  try {
    execFileSync(command, commandArgs, { cwd: repoRoot, stdio: 'inherit' });
  } catch (error) {
    if (options.optional) return;
    throw error;
  }
}
