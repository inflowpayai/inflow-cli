import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { detectPlatforms, selectPlatforms } from './detect-platform-changes.mjs';

const none = { linux: false, macos: false, windows: false };
const all = { linux: true, macos: true, windows: true };

const platformFiles = {
  linux: [
    '.github/workflows/linux-release.yml',
    'packaging/linux/vault-launcher.c',
    'packaging/linux/inflow-vault.service',
    'packages/core/native/vault_peer_linux.c',
    'scripts/build-linux-package.mjs',
    'scripts/test-linux-non-systemd-vault.mjs',
  ],
  macos: [
    '.github/workflows/macos-release.yml',
    'packages/core/native/vault_peer_darwin.c',
    'scripts/build-macos-app.mjs',
    'scripts/verify-macos-archive.test.mjs',
    'scripts/render-homebrew-cask.mjs',
  ],
  windows: [
    '.github/workflows/windows-release.yml',
    'packaging/windows/hosted-install.ps1',
    'packaging/windows/inflow.wxs',
    'packages/core/native/vault_peer_windows.c',
    'packages/core/native/vault_pipe_adapter_windows.h',
    'packages/core/test/native/vault_pipe_dispatcher_windows.c',
    'packages/core/test/native/vault-pipe-adapter-windows.mjs',
    'packages/core/src/secure-storage/vault-windows-transport.ts',
    'packages/core/test/unit/secure-storage/vault-windows-transport.test.ts',
    'scripts/build-windows-package.mjs',
    'scripts/verify-winget-manifests.mjs',
  ],
};

for (const [platform, paths] of Object.entries(platformFiles)) {
  test(`selects only ${platform} for its workflow, implementation, packaging and tests`, () => {
    for (const path of paths) {
      assert.deepEqual(selectPlatforms([path]), { ...none, [platform]: true }, path);
    }
  });
}

test('selects all platforms for shared dependencies, native code, build tooling and CI selection', () => {
  for (const path of [
    '.github/workflows/ci.yml',
    '.github/workflows/native-release.yml',
    'scripts/detect-platform-changes.mjs',
    'scripts/detect-platform-changes.test.mjs',
    'scripts/build-vault-peer-native.mjs',
    'scripts/prepare-argon2-source.mjs',
    'scripts/clean-bundle-artifacts.mjs',
    'packages/core/native/vault_crypto_native.c',
    'packages/core/native/vault_secure_memory.h',
    'packages/core/src/secure-storage/vault-daemon.ts',
    'packages/cli/src/startup-vault.ts',
    'packages/cli/src/commands/vault/index.ts',
    'packages/cli/src/cli.tsx',
    'packages/cli/test/integration/cli-smoke.test.ts',
    'packages/cli/tsup.standalone.config.ts',
    'package.json',
    'packages/core/package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'tsconfig.base.json',
    'turbo.json',
    '.node-version',
    '.npmrc',
    'patches/incur.patch',
    'packaging/hosted/cli',
  ])
    assert.deepEqual(selectPlatforms([path]), all, path);
});

test('keeps documentation, command presentation and known maintenance scripts in verify', () => {
  for (const path of [
    'README.md',
    '.changeset/example.md',
    'skills/agentic-enrollment/SKILL.md',
    'packages/cli/src/commands/aep/views.tsx',
    'packages/cli/test/integration/aep-document.test.ts',
    'scripts/align-skill-version.js',
    'scripts/check-changed-coverage.test.mjs',
    'scripts/local-link-workspace.mjs',
    'scripts/stage-web.mjs',
  ])
    assert.deepEqual(selectPlatforms([path]), none, path);
  assert.deepEqual(selectPlatforms([]), none);
});

test('selects Linux and macOS for their shared hosted installer', () => {
  assert.deepEqual(selectPlatforms(['packaging/hosted/install.sh']), { ...all, windows: false });
});

test('combines platform selections and lets shared changes select all', () => {
  const paths = ['scripts/build-linux-package.mjs', 'scripts/build-windows-package.mjs'];
  assert.deepEqual(selectPlatforms(paths), { ...all, macos: false });
  assert.deepEqual(selectPlatforms([...paths, 'packages/core/native/vault_crypto_native.c']), all);
});

test('selects all platforms for unclassified native, packaging, workflow and script paths', () => {
  for (const path of [
    'packages/core/native/new-helper.c',
    'packaging/new-layout/config',
    '.github/workflows/new-workflow.yml',
    'scripts/new-build-helper.mjs',
  ])
    assert.deepEqual(selectPlatforms([path]), all, path);
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function repository(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'inflow-platform-changes-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Platform Test');
  git(cwd, 'config', 'user.email', 'platform@example.test');
  await mkdir(join(cwd, '.github/workflows'), { recursive: true });
  await writeFile(join(cwd, '.github/workflows/linux-release.yml'), 'name: linux\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'initial');
  return cwd;
}

test('detects the Fedora workflow diagnostics case through a real Git comparison', async (t) => {
  const cwd = await repository(t);
  const base = git(cwd, 'rev-parse', 'HEAD');
  await writeFile(join(cwd, '.github/workflows/linux-release.yml'), 'name: linux\n# failure diagnostics\n');
  git(cwd, 'commit', '-am', 'diagnostics');
  assert.deepEqual(detectPlatforms({ cwd, base, head: 'HEAD', event: 'pull_request' }), { ...none, linux: true });
});

test('includes both paths of a rename and includes deletions', async (t) => {
  const cwd = await repository(t);
  const base = git(cwd, 'rev-parse', 'HEAD');
  await rename(join(cwd, '.github/workflows/linux-release.yml'), join(cwd, '.github/workflows/windows-release.yml'));
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-m', 'rename');
  assert.deepEqual(detectPlatforms({ cwd, base, head: 'HEAD', event: 'pull_request' }), { ...all, macos: false });
  const beforeDeletion = git(cwd, 'rev-parse', 'HEAD');
  await rm(join(cwd, '.github/workflows/windows-release.yml'));
  git(cwd, 'commit', '-am', 'delete');
  assert.deepEqual(detectPlatforms({ cwd, base: beforeDeletion, head: 'HEAD', event: 'push' }), {
    ...none,
    windows: true,
  });
});

test('uses the merge base for pull requests, not unrelated changes on the base branch', async (t) => {
  const cwd = await repository(t);
  const initial = git(cwd, 'rev-parse', 'HEAD');
  await writeFile(join(cwd, '.github/workflows/windows-release.yml'), 'name: windows\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'base branch change');
  const base = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'switch', '-c', 'feature', initial);
  await writeFile(join(cwd, '.github/workflows/linux-release.yml'), 'name: changed\n');
  git(cwd, 'commit', '-am', 'feature change');
  assert.deepEqual(detectPlatforms({ cwd, base, head: 'HEAD', event: 'pull_request' }), { ...none, linux: true });
  assert.deepEqual(detectPlatforms({ cwd, base, head: 'HEAD', event: 'push' }), { ...all, macos: false });
});

test('selects all platforms when revisions are unavailable', async (t) => {
  const cwd = await repository(t);
  for (const base of [undefined, '0000000000000000000000000000000000000000', 'missing-ref']) {
    assert.deepEqual(detectPlatforms({ cwd, base, head: 'HEAD', event: 'pull_request' }), all);
  }
  assert.deepEqual(detectPlatforms({ cwd, base: 'HEAD', event: 'push' }), all);
});

test('writes independent GitHub outputs and readable selected-platform results', async (t) => {
  const cwd = await repository(t);
  const output = join(cwd, 'outputs');
  const stdout = execFileSync(
    process.execPath,
    [fileURLToPath(new URL('./detect-platform-changes.mjs', import.meta.url))],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, BASE_SHA: 'HEAD', HEAD_SHA: 'HEAD', GITHUB_EVENT_NAME: 'push', GITHUB_OUTPUT: output },
    },
  );
  assert.equal(stdout, 'linux=false\nmacos=false\nwindows=false\n');
  assert.equal(await readFile(output, 'utf8'), stdout);
});

test('wires each platform to its own output without making verify conditional', async () => {
  const workflow = parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  for (const platform of ['linux', 'macos', 'windows']) {
    assert.equal(workflow.jobs.ci.outputs[platform], `\${{ steps.changes.outputs.${platform} }}`);
    assert.equal(workflow.jobs[`${platform}-development`].if, `needs.ci.outputs.${platform} == 'true'`);
    assert.equal(workflow.jobs[`${platform}-development`].needs, 'ci');
  }
  assert.equal(workflow.jobs.verify.if, undefined);
  assert.equal(workflow.jobs.verify.needs, 'ci');
  assert.equal(
    workflow.jobs.ci.steps.find((step) => step.id === 'changes').run,
    'node scripts/detect-platform-changes.mjs',
  );
});
