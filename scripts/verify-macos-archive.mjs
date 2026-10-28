#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const archive = process.argv[2];
if (process.platform !== 'darwin' || !archive) {
  throw new Error('Usage on macOS: node scripts/verify-macos-archive.mjs <archive.zip> [--notarized]');
}
const notarized = process.argv.includes('--notarized');
const directory = mkdtempSync(join(tmpdir(), 'inflow-macos-verify-'));
try {
  run('ditto', ['-x', '-k', resolve(archive), directory]);
  const app = join(directory, 'InFlow.app');
  const executable = join(app, 'Contents/MacOS/inflow');
  const minimum = run('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :LSMinimumSystemVersion',
    join(app, 'Contents/Info.plist'),
  ]).trim();
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
  for (const file of files(app)) {
    if (!run('file', ['-b', file]).includes('Mach-O')) continue;
    const commands = run('otool', ['-l', file]);
    const versions = [
      ...commands.matchAll(
        /\bminos\s+(\d+(?:\.\d+)*)|\bcmd LC_VERSION_MIN_MACOSX\s+cmdsize \d+\s+version (\d+(?:\.\d+)*)/gu,
      ),
    ];
    if (versions.length === 0) throw new Error(`Missing macOS deployment target: ${file}`);
    for (const match of versions) {
      const required = match[1] ?? match[2];
      if (compareVersions(required, minimum) > 0) {
        throw new Error(`${file} requires macOS ${required}, but the app declares ${minimum}.`);
      }
    }
  }
  if (notarized) {
    run('xcrun', ['stapler', 'validate', app]);
    run('spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
  }
  const version = run(executable, ['--version']).trim();
  const expected = run('/usr/libexec/PlistBuddy', [
    '-c',
    'Print :CFBundleShortVersionString',
    join(app, 'Contents/Info.plist'),
  ]).trim();
  if (version !== expected) throw new Error(`Expected version ${expected}, received ${version}.`);
  run(executable, ['--help']);
  console.log(`Verified extracted macOS archive: ${archive} (${version}, minimum macOS ${minimum})`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 60_000 });
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
