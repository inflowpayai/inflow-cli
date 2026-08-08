#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' && process.platform !== 'linux' && process.platform !== 'win32') {
  process.exit(0);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const platformName = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'windows';
const source = join(repoRoot, `packages/core/native/vault_peer_${platformName}.c`);
const secureMemorySource = join(repoRoot, 'packages/core/native/vault_secure_memory.c');
const cryptoSource = join(repoRoot, 'packages/core/native/vault_crypto_native.c');
const outputDirectory = join(repoRoot, 'packages/core/native/build');
const output = join(outputDirectory, `vault_peer_${platformName}.node`);

mkdirSync(outputDirectory, { recursive: true });
if (process.platform === 'win32') {
  buildWindowsNativeModule();
  process.exit(0);
}

const nodeInclude = resolve(dirname(process.execPath), '../include/node');
const platformArguments =
  process.platform === 'darwin' ? ['-dynamiclib', '-undefined', 'dynamic_lookup'] : ['-shared', '-fPIC'];
const argon2Arguments =
  process.env.INFLOW_ARGON2_SOURCE_DIR !== undefined
    ? pinnedArgon2Arguments(requiredDirectory('INFLOW_ARGON2_SOURCE_DIR'))
    : [
        ...execFileSync('pkg-config', ['--cflags', 'libargon2'], {
          cwd: repoRoot,
          encoding: 'utf8',
        })
          .trim()
          .split(/\s+/u)
          .filter((argument) => argument.length > 0),
        join(
          execFileSync('pkg-config', ['--variable=libdir', 'libargon2'], {
            cwd: repoRoot,
            encoding: 'utf8',
          }).trim(),
          'libargon2.a',
        ),
      ];
execFileSync(
  'cc',
  [
    '-std=c11',
    '-Wall',
    '-Wextra',
    '-Werror',
    ...platformArguments,
    '-I',
    nodeInclude,
    source,
    secureMemorySource,
    cryptoSource,
    ...argon2Arguments,
    '-o',
    output,
  ],
  {
    cwd: repoRoot,
    stdio: 'inherit',
  },
);

function buildWindowsNativeModule() {
  const nodeIncludeDirectory = requiredDirectory('INFLOW_NODE_INCLUDE_DIR');
  const nodeLibrary = requiredPath('INFLOW_NODE_LIBRARY');
  const argon2Root = requiredDirectory('INFLOW_ARGON2_SOURCE_DIR');
  const argon2Sources = [
    join(argon2Root, 'src/argon2.c'),
    join(argon2Root, 'src/core.c'),
    join(argon2Root, 'src/encoding.c'),
    join(argon2Root, 'src/ref.c'),
    join(argon2Root, 'src/blake2/blake2b.c'),
  ];
  for (const argon2Source of argon2Sources) requiredPathValue(argon2Source);
  execFileSync(
    'cl.exe',
    [
      '/nologo',
      '/LD',
      '/std:c11',
      '/W4',
      '/WX',
      '/guard:cf',
      '/DARGON2_NO_THREADS',
      '/D_CRT_SECURE_NO_WARNINGS',
      `/I${nodeIncludeDirectory}`,
      `/I${join(argon2Root, 'include')}`,
      `/I${join(argon2Root, 'src')}`,
      source,
      secureMemorySource,
      cryptoSource,
      ...argon2Sources,
      '/link',
      '/guard:cf',
      '/DYNAMICBASE',
      '/NXCOMPAT',
      `/out:${output}`,
      nodeLibrary,
      'advapi32.lib',
      'bcrypt.lib',
      'crypt32.lib',
      'wintrust.lib',
      'wtsapi32.lib',
    ],
    {
      cwd: repoRoot,
      stdio: 'inherit',
    },
  );
}

function buildPinnedArgon2Objects(argon2Root) {
  const sources = [
    join(argon2Root, 'src/argon2.c'),
    join(argon2Root, 'src/core.c'),
    join(argon2Root, 'src/encoding.c'),
    join(argon2Root, 'src/ref.c'),
    join(argon2Root, 'src/blake2/blake2b.c'),
  ];
  return sources.map((argon2Source, index) => {
    const object = join(outputDirectory, `argon2-${index}.o`);
    execFileSync(
      'cc',
      [
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Wno-type-limits',
        '-fPIC',
        '-DARGON2_NO_THREADS',
        '-I',
        join(argon2Root, 'include'),
        '-I',
        join(argon2Root, 'src'),
        '-c',
        argon2Source,
        '-o',
        object,
      ],
      {
        cwd: repoRoot,
        stdio: 'inherit',
      },
    );
    return object;
  });
}

function pinnedArgon2Arguments(argon2Root) {
  return ['-I', join(argon2Root, 'include'), '-I', join(argon2Root, 'src'), ...buildPinnedArgon2Objects(argon2Root)];
}

function requiredDirectory(name) {
  return requiredPathValue(requiredEnvironment(name));
}

function requiredPath(name) {
  return requiredPathValue(requiredEnvironment(name));
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must identify the pinned native-build dependency.`);
  }
  return resolve(value);
}

function requiredPathValue(path) {
  const resolvedPath = resolve(path);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Native-build dependency is unavailable: ${path}`);
  }
  return resolvedPath;
}
