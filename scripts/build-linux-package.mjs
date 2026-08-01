#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
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
if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
  throw new Error('Linux packaging requires root so release ownership can be normalized.');
}

rmSync(artifactRoot, { force: true, recursive: true });
mkdirSync(buildRoot, { recursive: true });
mkdirSync(dirname(executablePath), { recursive: true });
mkdirSync(runtimePath, { recursive: true });

run('pnpm', ['--filter', '@inflowpayai/inflow-core', 'build']);
run(process.execPath, ['scripts/build-vault-peer-native.mjs']);
run('pnpm', ['--filter', '@inflowpayai/inflow', 'build:standalone']);

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
linkExecutable();
normalizeRuntimePermissions(packageRoot);
chmodSync(executablePath, 0o755);
run('chown', ['-R', '0:0', packageRoot]);
archive();
const nativePackages = buildNativePackages();

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
      packages: nativePackages,
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
  symlinkSync(`../${packageName}/bin/inflow`, linkedPath);
}

function archive() {
  run('tar', ['-C', artifactRoot, '-czf', archivePath, packageName]);
}

function buildNativePackages() {
  const packages = {};
  if (commandExists('dpkg-deb')) packages.deb = packageMetadata(buildDebianPackage());
  if (commandExists('rpmbuild')) packages.rpm = packageMetadata(buildRpmPackage());
  return packages;
}

function packageMetadata(path) {
  const checksum = sha256(path);
  writeFileSync(`${path}.sha256`, `${checksum}  ${path.split('/').at(-1)}\n`);
  return { path, sha256: checksum };
}

function buildDebianPackage() {
  const debianRoot = join(buildRoot, 'debian');
  installLinuxTree(debianRoot);
  const controlDirectory = join(debianRoot, 'DEBIAN');
  mkdirSync(controlDirectory, { recursive: true });
  writeFileSync(
    join(controlDirectory, 'control'),
    [
      'Package: inflow',
      `Version: ${version}`,
      `Architecture: ${debianArchitecture()}`,
      'Maintainer: InFlow <support@inflowpay.ai>',
      'Depends: systemd',
      'Section: utils',
      'Priority: optional',
      'Description: InFlow agent-native payment command line',
      '',
    ].join('\n'),
  );
  writeMaintainerScript(
    join(controlDirectory, 'postinst'),
    `#!/bin/sh
set -e
if command -v systemd-sysusers >/dev/null 2>&1; then
  systemd-sysusers /usr/lib/sysusers.d/inflow.conf
elif ! getent passwd inflow >/dev/null; then
  useradd --system --user-group --home-dir /var/lib/inflow --shell /usr/sbin/nologin inflow
fi
inflow_uid=$(id -u inflow)
inflow_home=$(getent passwd inflow | cut -d: -f6)
inflow_shell=$(getent passwd inflow | cut -d: -f7)
if [ "$inflow_uid" -eq 0 ] || [ "$inflow_uid" -ge 1000 ] ||
   [ "$inflow_home" != /var/lib/inflow ] ||
   { [ "$inflow_shell" != /usr/sbin/nologin ] && [ "$inflow_shell" != /sbin/nologin ]; }; then
  echo "The existing inflow account is not a compatible locked system identity." >&2
  exit 1
fi
if command -v systemd-tmpfiles >/dev/null 2>&1; then
  systemd-tmpfiles --create /usr/lib/tmpfiles.d/inflow.conf
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
  systemctl preset inflow-vault.socket || systemctl enable inflow-vault.socket || true
  systemctl stop inflow-vault.service inflow-vault.socket || true
  systemctl start inflow-vault.socket || true
fi
`,
  );
  writeMaintainerScript(
    join(controlDirectory, 'prerm'),
    `#!/bin/sh
set -e
if [ "$1" = remove ] && command -v systemctl >/dev/null 2>&1; then
  systemctl stop inflow-vault.service inflow-vault.socket || true
  systemctl disable inflow-vault.socket || true
fi
`,
  );
  writeMaintainerScript(
    join(controlDirectory, 'postrm'),
    `#!/bin/sh
set -e
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
fi
if [ "$1" = purge ]; then
  rm -rf /var/lib/inflow /run/inflow
fi
`,
  );
  const output = join(artifactRoot, `inflow_${version}_${debianArchitecture()}.deb`);
  run('dpkg-deb', ['--root-owner-group', '--build', debianRoot, output]);
  return output;
}

function buildRpmPackage() {
  const rpmRoot = join(buildRoot, 'rpm');
  const sourceRoot = join(rpmRoot, 'SOURCES', `inflow-${version}`);
  const specsRoot = join(rpmRoot, 'SPECS');
  installLinuxTree(sourceRoot);
  mkdirSync(specsRoot, { recursive: true });
  const sourceArchive = join(rpmRoot, 'SOURCES', `inflow-${version}.tar.gz`);
  run('tar', ['-C', join(rpmRoot, 'SOURCES'), '-czf', sourceArchive, `inflow-${version}`]);
  const specPath = join(specsRoot, 'inflow.spec');
  writeFileSync(
    specPath,
    `%global __strip /bin/true
Name: inflow
Version: ${version}
Release: 1%{?dist}
Summary: InFlow agent-native payment command line
License: MIT
Source0: %{name}-%{version}.tar.gz
BuildArch: ${rpmArchitecture()}
Requires: systemd

%description
InFlow agent-native and human-accessible payment command line.

%prep
%setup -q

%build

%install
mkdir -p %{buildroot}
cp -a . %{buildroot}/

%post
if command -v systemd-sysusers >/dev/null 2>&1; then
  systemd-sysusers /usr/lib/sysusers.d/inflow.conf || :
fi
inflow_uid=$(id -u inflow)
inflow_home=$(getent passwd inflow | cut -d: -f6)
inflow_shell=$(getent passwd inflow | cut -d: -f7)
if [ "$inflow_uid" -eq 0 ] || [ "$inflow_uid" -ge 1000 ] ||
   [ "$inflow_home" != /var/lib/inflow ] ||
   { [ "$inflow_shell" != /usr/sbin/nologin ] && [ "$inflow_shell" != /sbin/nologin ]; }; then
  echo "The existing inflow account is not a compatible locked system identity." >&2
  exit 1
fi
if command -v systemd-tmpfiles >/dev/null 2>&1; then
  systemd-tmpfiles --create /usr/lib/tmpfiles.d/inflow.conf || :
fi
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || :
  systemctl preset inflow-vault.socket || systemctl enable inflow-vault.socket || :
fi

%posttrans
systemctl stop inflow-vault.service inflow-vault.socket >/dev/null 2>&1 || :
systemctl start inflow-vault.socket >/dev/null 2>&1 || :

%preun
if [ "$1" -eq 0 ] && command -v systemctl >/dev/null 2>&1; then
  systemctl stop inflow-vault.service inflow-vault.socket || :
  systemctl disable inflow-vault.socket || :
fi

%postun
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || :
fi

%files
/opt/inflow
/usr/bin/inflow
/usr/lib/systemd/system/inflow-vault.service
/usr/lib/systemd/system/inflow-vault.socket
/usr/lib/sysusers.d/inflow.conf
/usr/lib/tmpfiles.d/inflow.conf
`,
  );
  run('rpmbuild', ['--define', `_topdir ${rpmRoot}`, '-bb', specPath]);
  const rpmDirectory = join(rpmRoot, 'RPMS', rpmArchitecture());
  const rpmName = readdirSync(rpmDirectory).find((name) => name.endsWith('.rpm'));
  if (rpmName === undefined) throw new Error('RPM output is missing.');
  const built = join(rpmDirectory, rpmName);
  const output = join(artifactRoot, rpmName);
  copyFileSync(built, output);
  return output;
}

function installLinuxTree(root) {
  cpSync(join(packageRoot, 'bin'), join(root, 'opt/inflow/bin'), { recursive: true });
  cpSync(join(packageRoot, 'lib'), join(root, 'opt/inflow/lib'), { recursive: true });
  normalizeRuntimePermissions(join(root, 'opt/inflow'));
  chmodSync(join(root, 'opt/inflow/bin/inflow'), 0o755);
  mkdirSync(join(root, 'usr/bin'), { recursive: true });
  symlinkSync('/opt/inflow/bin/inflow', join(root, 'usr/bin/inflow'));
  mkdirSync(join(root, 'usr/lib/systemd/system'), { recursive: true });
  copyFileSync(
    join(repoRoot, 'packaging/linux/inflow-vault.service'),
    join(root, 'usr/lib/systemd/system/inflow-vault.service'),
  );
  chmodSync(join(root, 'usr/lib/systemd/system/inflow-vault.service'), 0o644);
  copyFileSync(
    join(repoRoot, 'packaging/linux/inflow-vault.socket'),
    join(root, 'usr/lib/systemd/system/inflow-vault.socket'),
  );
  chmodSync(join(root, 'usr/lib/systemd/system/inflow-vault.socket'), 0o644);
  mkdirSync(join(root, 'usr/lib/sysusers.d'), { recursive: true });
  copyFileSync(join(repoRoot, 'packaging/linux/inflow.conf'), join(root, 'usr/lib/sysusers.d/inflow.conf'));
  chmodSync(join(root, 'usr/lib/sysusers.d/inflow.conf'), 0o644);
  mkdirSync(join(root, 'usr/lib/tmpfiles.d'), { recursive: true });
  copyFileSync(join(repoRoot, 'packaging/linux/inflow-tmpfiles.conf'), join(root, 'usr/lib/tmpfiles.d/inflow.conf'));
  chmodSync(join(root, 'usr/lib/tmpfiles.d/inflow.conf'), 0o644);
}

function normalizeRuntimePermissions(root) {
  chmodSync(root, 0o755);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      normalizeRuntimePermissions(entryPath);
    } else if (entry.isFile()) {
      chmodSync(entryPath, 0o644);
    }
  }
}

function writeMaintainerScript(path, content) {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function commandExists(command) {
  try {
    execFileSync('/bin/sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function debianArchitecture() {
  return architecture === 'x64' ? 'amd64' : 'arm64';
}

function rpmArchitecture() {
  return architecture === 'x64' ? 'x86_64' : 'aarch64';
}

function writeSeaMain() {
  const cliSource = readFileSync(join(repoRoot, 'packages/cli/dist/cli.standalone.mjs')).toString('base64');
  const runtimeManifest = runtimeFiles().map((path) => [relative(runtimePath, path), sha256(path)]);
  writeFileSync(
    seaMainPath,
    `const { createHash } = require('node:crypto');
const { lstatSync, readdirSync, readFileSync, realpathSync } = require('node:fs');
const { dirname, join, relative, resolve } = require('node:path');

const executablePath = realpathSync(process.execPath);
const runtimeRoot = resolve(dirname(executablePath), '../lib/inflow');
const manifest = new Map(${JSON.stringify(runtimeManifest)});

function files(root) {
  verifyOwnedPath(root, 'directory');
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.isFile() ? [path] : [];
  });
}

function verifyOwnedPath(path, type) {
  const stat = lstatSync(path);
  if (stat.uid !== 0 || (stat.mode & 0o022) !== 0 || (type === 'file' ? !stat.isFile() : !stat.isDirectory())) {
    throw new Error('unsafe runtime ownership');
  }
  if (realpathSync(path) !== path) throw new Error('unsafe runtime path');
}

try {
  verifyOwnedPath(executablePath, 'file');
  verifyOwnedPath(runtimeRoot, 'directory');
  const actualFiles = files(runtimeRoot).map((path) => relative(runtimeRoot, path)).sort();
  const expectedFiles = [...manifest.keys()].sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) throw new Error('runtime file set mismatch');
  for (const [name, expectedHash] of manifest) {
    const path = join(runtimeRoot, name);
    verifyOwnedPath(path, 'file');
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
