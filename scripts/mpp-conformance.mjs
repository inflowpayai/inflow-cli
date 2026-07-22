import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { get } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockPath = join(root, 'conformance', 'mpp-tools.lock.json');
const cacheRoot = join(root, 'node_modules', '.cache', 'mpp-conformance');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (cause?.code === 'ENOENT') return false;
    throw cause;
  }
}

function download(url, destination) {
  return new Promise((resolveDownload, reject) => {
    get(url, { headers: { 'user-agent': 'inflow-cli-conformance' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        download(response.headers.location, destination).then(resolveDownload, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}`));
        return;
      }
      pipeline(response, createWriteStream(destination)).then(resolveDownload, reject);
    }).on('error', reject);
  });
}

async function checksum(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

async function acquire(lock) {
  const revisionRoot = join(cacheRoot, lock.revision);
  const sourceRoot = join(revisionRoot, `mpp-tools-${lock.revision}`);
  if (await exists(join(sourceRoot, 'conformance', 'scripts', 'vector_runner.py'))) return sourceRoot;
  await mkdir(revisionRoot, { recursive: true });
  const archive = join(revisionRoot, 'archive.tar.gz');
  const partial = `${archive}.partial`;
  await download(`https://codeload.github.com/${lock.repository}/tar.gz/${lock.revision}`, partial);
  const actual = await checksum(partial);
  if (actual !== lock.sha256)
    throw new Error(`mpp-tools archive checksum mismatch: expected ${lock.sha256}, got ${actual}`);
  await rename(partial, archive);
  run('tar', ['-xzf', archive, '-C', revisionRoot]);
  return sourceRoot;
}

async function update() {
  const current = JSON.parse(await readFile(lockPath, 'utf8'));
  const response = await fetch(`https://api.github.com/repos/${current.repository}/commits/main`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'inflow-cli-conformance' },
  });
  if (!response.ok) throw new Error(`Unable to resolve mpp-tools main: HTTP ${response.status}`);
  const revision = (await response.json()).sha;
  const revisionRoot = join(cacheRoot, revision);
  await mkdir(revisionRoot, { recursive: true });
  const archive = join(revisionRoot, 'archive.tar.gz');
  await download(`https://codeload.github.com/${current.repository}/tar.gz/${revision}`, archive);
  await writeFile(
    lockPath,
    `${JSON.stringify({ repository: current.repository, revision, sha256: await checksum(archive) }, null, 2)}\n`,
  );
  process.stdout.write(`Pinned ${current.repository}@${revision}\n`);
}

async function conformance() {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  const sourceRoot = await acquire(lock);
  const conformanceRoot = join(sourceRoot, 'conformance');
  const pythonRoot = join(cacheRoot, lock.revision, 'python');
  const python =
    process.platform === 'win32' ? join(pythonRoot, 'Scripts', 'python.exe') : join(pythonRoot, 'bin', 'python');
  if (!(await exists(python))) run('python3', ['-m', 'venv', pythonRoot]);
  const installed = join(pythonRoot, '.requirements-installed');
  if (!(await exists(installed))) {
    run(python, [
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '-q',
      '-r',
      join(conformanceRoot, 'requirements.txt'),
    ]);
    await writeFile(installed, `${lock.revision}\n`);
  }

  run('pnpm', ['--filter', '@inflowpayai/inflow-core', 'build'], { cwd: root });
  const adapterRoot = join(conformanceRoot, 'adapters', 'inflow-cli');
  await mkdir(adapterRoot, { recursive: true });
  await writeFile(
    join(adapterRoot, 'adapter.json'),
    `${JSON.stringify(
      {
        $schema: '../../schemas/adapter-manifest.schema.json',
        schema: 1,
        name: 'inflow-cli',
        language: 'typescript',
        command: [process.execPath, join(root, 'conformance', 'mpp-adapter.mjs')],
        capabilities: [
          'challenge.parse',
          'challenge.format',
          'credential.parse',
          'credential.format',
          'receipt.parse',
          'receipt.format',
        ],
      },
      null,
      2,
    )}\n`,
  );
  for (const vector of ['www-authenticate', 'authorization', 'receipt']) {
    run(python, [join(conformanceRoot, 'scripts', 'vector_runner.py'), '--adapter', 'inflow-cli', '--vector', vector], {
      cwd: conformanceRoot,
    });
  }
}

if (process.argv.includes('--update')) await update();
else await conformance();
