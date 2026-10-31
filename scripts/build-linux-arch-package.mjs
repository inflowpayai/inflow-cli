#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = resolve(process.env.INFLOW_LINUX_ARTIFACT_DIR ?? join(repoRoot, 'dist/linux'));
const version = JSON.parse(readFileSync(join(repoRoot, 'packages/cli/package.json'), 'utf8')).version;
const architecture = { arm64: 'aarch64', x64: 'x86_64' }[process.arch];
if (process.platform !== 'linux' || architecture === undefined) throw new Error('Unsupported Arch package platform.');
if (process.getuid?.() === 0) throw new Error('Arch packaging must run as a non-root user.');
if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('Arch packaging requires a stable package version.');
const runtime = `inflow-${version}-linux-${process.arch}`;
const workspace = mkdtempSync(join(tmpdir(), 'inflow-arch-package-'));

try {
  const sources = [
    [join(artifactRoot, `${runtime}.tar.gz`), 'runtime.tar.gz'],
    ...['inflow-vault.service', 'inflow-vault.socket', 'inflow.conf', 'inflow-tmpfiles.conf'].map((name) => [
      join(repoRoot, 'packaging/linux', name),
      name,
    ]),
    [join(repoRoot, 'LICENSE'), 'LICENSE'],
  ];
  for (const [source, name] of sources) copyFileSync(source, join(workspace, name));
  const checksums = sources.map(([, name]) => `'${sha256(join(workspace, name))}'`).join(' ');
  const template = readFileSync(join(repoRoot, 'packaging/linux/arch/PKGBUILD.template'), 'utf8');
  writeFileSync(
    join(workspace, 'PKGBUILD'),
    template
      .replaceAll('__INFLOW_VERSION__', version)
      .replaceAll('__INFLOW_ARCH__', architecture)
      .replaceAll('__INFLOW_RUNTIME__', runtime)
      .replaceAll('__INFLOW_CHECKSUMS__', checksums),
  );
  copyFileSync(join(repoRoot, 'packaging/linux/arch/inflow.install'), join(workspace, 'inflow.install'));
  const config = join(workspace, 'makepkg.conf');
  writeFileSync(
    config,
    `${readFileSync('/etc/makepkg.conf', 'utf8')}\nCARCH=${architecture}\nPKGEXT='.pkg.tar.zst'\nPACKAGER='InFlow <support@inflowpay.ai>'\n`,
  );
  // Ubuntu builds the package from existing binaries; Arch resolves runtime dependencies when installing it.
  execFileSync('makepkg', ['--config', config, '--nodeps', '--noconfirm'], { cwd: workspace, stdio: 'inherit' });
  const name = `inflow-${version}-1-${architecture}.pkg.tar.zst`;
  const output = join(artifactRoot, name);
  copyFileSync(join(workspace, name), output);
  writeFileSync(`${output}.sha256`, `${sha256(output)}  ${name}\n`);
  process.stdout.write(`Packaged ${output}\n`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
