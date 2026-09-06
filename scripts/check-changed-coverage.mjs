#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const baseRef = process.env.PATCH_COVERAGE_BASE ?? githubBaseRef() ?? 'origin/main';
const target = Number(process.env.PATCH_COVERAGE_TARGET ?? '90');
const lcovFiles = ['packages/cli/coverage/lcov.info', 'packages/core/coverage/lcov.info'];
const excludedSources = new Set(['packages/cli/src/cli.tsx']);
const sourcePaths = ['packages/cli/src', 'packages/core/src'];

if (!Number.isFinite(target) || target < 0 || target > 100) {
  throw new Error(`PATCH_COVERAGE_TARGET must be a percentage from 0 through 100; got ${String(target)}.`);
}

const coverage = new Map();
const branchCoverage = new Map();
for (const lcovFile of lcovFiles) {
  readLcov(lcovFile, coverage, branchCoverage);
}

const changed = changedSourceLines(baseRef);
let covered = 0;
let executable = 0;
const missing = [];
const fileCoverageResults = [];

for (const [file, lines] of [...changed.entries()].sort()) {
  const fileCoverage = coverage.get(file);
  if (fileCoverage === undefined) {
    missing.push({ file, lines: [...lines].sort((left, right) => left - right), reason: 'no coverage data' });
    continue;
  }
  let fileCovered = 0;
  let fileExecutable = 0;
  for (const line of [...lines].sort((left, right) => left - right)) {
    const hits = fileCoverage.get(line);
    if (hits === undefined) continue;
    executable += 1;
    fileExecutable += 1;
    if (hits === 0) missing.push({ file, lines: [line], reason: 'uncovered' });
    else if (isPartiallyCovered(branchCoverage.get(file)?.get(line)))
      missing.push({ file, lines: [line], reason: 'partially covered' });
    else {
      covered += 1;
      fileCovered += 1;
    }
  }
  if (fileExecutable > 0) {
    fileCoverageResults.push({ file, covered: fileCovered, executable: fileExecutable });
  }
}

if (executable === 0 && missing.length === 0) {
  process.stdout.write('Changed-line coverage: no changed executable source lines.\n');
  process.exit(0);
}

const percentage = executable === 0 ? 0 : (covered / executable) * 100;
const failingFiles = fileCoverageResults.filter(({ covered: fileCovered, executable: fileExecutable }) => {
  return (fileCovered / fileExecutable) * 100 < target;
});
process.stdout.write(
  `Changed-line coverage: ${covered}/${executable} executable changed source lines (${percentage.toFixed(2)}%).\n`,
);

if (failingFiles.length > 0) {
  process.stdout.write('Changed files below target:\n');
  for (const { file, covered: fileCovered, executable: fileExecutable } of failingFiles) {
    const filePercentage = (fileCovered / fileExecutable) * 100;
    process.stdout.write(`- ${file}: ${fileCovered}/${fileExecutable} (${filePercentage.toFixed(2)}%)\n`);
  }
}

if (missing.length > 0) {
  process.stdout.write('Uncovered changed lines:\n');
  for (const item of collapseMissing(missing)) {
    process.stdout.write(`- ${item.file}:${item.lines} (${item.reason})\n`);
  }
}

if (missing.some((item) => item.reason === 'no coverage data') || percentage < target || failingFiles.length > 0) {
  const failures = [];
  if (percentage < target) failures.push(`aggregate ${percentage.toFixed(2)}% < ${target.toFixed(2)}%`);
  if (failingFiles.length > 0) failures.push(`${String(failingFiles.length)} changed file(s) below target`);
  if (missing.some((item) => item.reason === 'no coverage data')) failures.push('changed source missing coverage data');
  process.stderr.write(`Changed-line coverage target not met: ${failures.join('; ')}.\n`);
  process.exit(1);
}

function readLcov(lcovFile, out, partialBranches) {
  const absolute = resolve(repoRoot, lcovFile);
  if (!existsSync(absolute)) {
    throw new Error(`Missing coverage report: ${lcovFile}. Run pnpm test before pnpm coverage:changed.`);
  }
  const packageRoot = lcovFile.split('/coverage/')[0];
  let current;
  for (const line of readFileSync(absolute, 'utf8').split('\n')) {
    if (line.startsWith('SF:')) {
      current = normalizeSourcePath(packageRoot, line.slice(3));
      out.set(current, new Map());
      partialBranches.set(current, new Map());
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith('DA:')) {
      const [lineNumber, hits] = line.slice(3).split(',');
      out.get(current)?.set(Number(lineNumber), Number(hits));
      continue;
    }
    if (line.startsWith('BRDA:')) {
      const [lineNumber, , , hits] = line.slice(5).split(',');
      const branches = partialBranches.get(current);
      const state = branches.get(Number(lineNumber)) ?? { covered: false, missed: false };
      if (hits === '-' || Number(hits) === 0) state.missed = true;
      else state.covered = true;
      branches.set(Number(lineNumber), state);
    }
  }
}

function isPartiallyCovered(state) {
  return state?.covered === true && state.missed;
}

function normalizeSourcePath(packageRoot, sourceFile) {
  if (sourceFile.startsWith('/')) return relative(repoRoot, sourceFile);
  return `${packageRoot}/${sourceFile}`;
}

function changedSourceLines(ref) {
  const mergeBase = execFileSync('git', ['merge-base', ref, 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const diff = execFileSync('git', ['diff', '--unified=0', mergeBase, '--', ...sourcePaths], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const changedLines = new Map();
  let currentFile;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const file = line.startsWith('+++ b/') ? line.slice('+++ b/'.length) : undefined;
      currentFile = file !== undefined && isIncludedSource(file) ? file : undefined;
      continue;
    }
    if (currentFile === undefined || !line.startsWith('@@')) continue;
    const match = /\+(\d+)(?:,(\d+))?/.exec(line);
    if (match === null) continue;
    const start = Number(match[1]);
    const count = Number(match[2] ?? '1');
    if (count === 0) continue;
    const lines = changedLines.get(currentFile) ?? new Set();
    for (let offset = 0; offset < count; offset += 1) {
      lines.add(start + offset);
    }
    changedLines.set(currentFile, lines);
  }
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', ...sourcePaths], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  for (const file of untracked.split('\n').filter(isIncludedSource)) {
    const contents = readFileSync(resolve(repoRoot, file), 'utf8');
    const count = contents.length === 0 ? 0 : contents.split('\n').length - (contents.endsWith('\n') ? 1 : 0);
    changedLines.set(file, new Set(Array.from({ length: count }, (_value, index) => index + 1)));
  }
  return changedLines;
}

function isIncludedSource(file) {
  return !excludedSources.has(file) && /\.[cm]?[jt]sx?$/.test(file);
}

function collapseMissing(items) {
  const groups = new Map();
  for (const item of items) {
    const key = `${item.file}\0${item.reason}`;
    const group = groups.get(key) ?? { file: item.file, reason: item.reason, lineNumbers: [] };
    group.lineNumbers.push(...item.lines);
    groups.set(key, group);
  }
  return [...groups.values()].map((item) => ({
    file: item.file,
    reason: item.reason,
    lines: ranges([...new Set(item.lineNumbers)].sort((left, right) => left - right)),
  }));
}

function ranges(lines) {
  const rangesOut = [];
  let start;
  let previous;
  for (const line of lines) {
    if (start === undefined) {
      start = line;
      previous = line;
      continue;
    }
    if (line === previous + 1) {
      previous = line;
      continue;
    }
    rangesOut.push(start === previous ? `${start}` : `${start}-${previous}`);
    start = line;
    previous = line;
  }
  if (start !== undefined && previous !== undefined) {
    rangesOut.push(start === previous ? `${start}` : `${start}-${previous}`);
  }
  return rangesOut.join(',');
}

function githubBaseRef() {
  const ref = process.env.GITHUB_BASE_REF;
  if (ref === undefined || ref.length === 0) return undefined;
  if (ref.startsWith('refs/') || ref.includes('/')) return ref;
  return `origin/${ref}`;
}
