import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceScript = fileURLToPath(new URL('./check-changed-coverage.mjs', import.meta.url));

async function createRepository(t) {
  const root = await mkdtemp(join(tmpdir(), 'inflow-changed-coverage-'));
  t.after(() => rm(root, { recursive: true }));
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'packages/core/src'), { recursive: true });
  await mkdir(join(root, 'packages/core/coverage'), { recursive: true });
  await mkdir(join(root, 'packages/cli/coverage'), { recursive: true });
  await copyFile(sourceScript, join(root, 'scripts/check-changed-coverage.mjs'));
  await writeFile(join(root, '.gitignore'), '**/coverage/\n');
  await writeFile(join(root, 'packages/core/src/existing.ts'), 'export const value = 1;\n');
  git(root, 'init');
  git(root, 'config', 'user.email', 'coverage@example.test');
  git(root, 'config', 'user.name', 'Coverage Test');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
  await writeFile(join(root, 'packages/cli/coverage/lcov.info'), '');
  return root;
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function writeCoverage(root, file, hits, branches = [], append = false) {
  const lines = [`SF:src/${file}`, ...hits.map((count, index) => `DA:${String(index + 1)},${String(count)}`)];
  lines.push(...branches, 'end_of_record', '');
  await writeFile(join(root, 'packages/core/coverage/lcov.info'), lines.join('\n'), append ? { flag: 'a' } : undefined);
}

function check(root, baseRef, target = '100') {
  const result = runCheck(root, baseRef, target);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout;
}

function checkFailure(root, baseRef, target = '100') {
  const result = runCheck(root, baseRef, target);
  assert.notEqual(result.status, 0);
  return `${result.stdout}${result.stderr}`;
}

function runCheck(root, baseRef, target) {
  return spawnSync(process.execPath, ['scripts/check-changed-coverage.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATCH_COVERAGE_BASE: baseRef, PATCH_COVERAGE_TARGET: target },
  });
}

for (const state of ['committed', 'staged', 'unstaged']) {
  test(`measures ${state} source changes`, async (t) => {
    const root = await createRepository(t);
    const baseRef = git(root, 'rev-parse', 'HEAD');
    await writeFile(join(root, 'packages/core/src/existing.ts'), 'export const value = 2;\nexport const added = 3;\n');
    if (state !== 'unstaged') git(root, 'add', 'packages/core/src/existing.ts');
    if (state === 'committed') git(root, 'commit', '-m', 'change source');
    await writeCoverage(root, 'existing.ts', [1, 1]);

    assert.match(check(root, baseRef), /Changed-line coverage: 2\/2 executable changed source lines \(100\.00%\)\./);
  });
}

test('measures untracked source files', async (t) => {
  const root = await createRepository(t);
  const baseRef = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'packages/core/src/new.ts'), 'export const first = 1;\nexport const second = 2;\n');
  await writeCoverage(root, 'new.ts', [1, 1]);

  assert.match(check(root, baseRef), /Changed-line coverage: 2\/2 executable changed source lines \(100\.00%\)\./);
});

test('matches Codecov partial-line coverage when a covered line has an uncovered branch', async (t) => {
  const root = await createRepository(t);
  const baseRef = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'packages/core/src/existing.ts'), 'export const value = true ? 1 : 2;\n');
  await writeCoverage(root, 'existing.ts', [1], ['BRDA:1,0,0,1', 'BRDA:1,0,1,0']);

  const output = checkFailure(root, baseRef);
  assert.match(output, /Changed-line coverage: 0\/1 executable changed source lines \(0\.00%\)\./);
  assert.match(output, /packages\/core\/src\/existing\.ts:1 \(partially covered\)/);
});

test('rejects an uncovered changed executable line', async (t) => {
  const root = await createRepository(t);
  const baseRef = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'packages/core/src/existing.ts'), 'export const value = 2;\n');
  await writeCoverage(root, 'existing.ts', [0]);

  const output = checkFailure(root, baseRef);
  assert.match(output, /Changed-line coverage: 0\/1 executable changed source lines \(0\.00%\)\./);
  assert.match(output, /packages\/core\/src\/existing\.ts:1 \(uncovered\)/);
});

test('rejects a changed source file missing from coverage data', async (t) => {
  const root = await createRepository(t);
  const baseRef = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'packages/core/src/existing.ts'), 'export const value = 2;\n');
  await writeCoverage(root, 'other.ts', [1]);

  const output = checkFailure(root, baseRef);
  assert.match(output, /packages\/core\/src\/existing\.ts:1 \(no coverage data\)/);
});

test('rejects a changed file below target when aggregate coverage meets target', async (t) => {
  const root = await createRepository(t);
  const baseRef = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'packages/core/src/existing.ts'), 'export const value = 2;\n');
  await writeFile(
    join(root, 'packages/core/src/new.ts'),
    Array.from({ length: 9 }, (_value, index) => `export const value${String(index)} = ${String(index)};`).join('\n'),
  );
  await writeCoverage(root, 'existing.ts', [0]);
  await writeCoverage(
    root,
    'new.ts',
    Array.from({ length: 9 }, () => 1),
    [],
    true,
  );

  const output = checkFailure(root, baseRef, '90');
  assert.match(output, /Changed-line coverage: 9\/10 executable changed source lines \(90\.00%\)\./);
  assert.match(output, /packages\/core\/src\/existing\.ts: 0\/1 \(0\.00%\)/);
});
