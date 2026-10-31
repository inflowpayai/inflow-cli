import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.env.INFLOW_DISPOSABLE_CONTAINER !== '1') {
  throw new Error('Run only as root in a disposable Arch Linux test container.');
}
const release = process.argv[2];
if (release === undefined) throw new Error('A signed test release directory is required.');
const installer = join(release, 'install.sh');
const env = { ...process.env, INFLOW_RELEASE_BASE_URL: `file://${release}` };
const asUser = ['--reuid=1001', '--regid=1001', '--clear-groups', 'inflow'];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', env, timeout: 120000, ...options });
  assert.equal(result.status, 0, `${command}: ${result.stdout}${result.stderr}`);
  return result.stdout;
}

function status() {
  return JSON.parse(run('setpriv', [...asUser, 'vault', 'status', '--format', 'json'])).lock_state;
}

async function unlock(initial) {
  await new Promise((resolve, reject) => {
    const child = spawn('script', ['-qec', ['setpriv', ...asUser, 'vault', 'unlock'].join(' '), '/dev/null'], { env });
    let output = '';
    let answered = false;
    const timer = setTimeout(() => child.kill('SIGTERM'), 20000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (!answered && output.includes('passphrase: ')) {
        answered = true;
        child.stdin.end('synthetic-arch-package-test-passphrase\n');
      }
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || !output.includes(initial ? 'Vault initialized and unlocked.' : 'Vault unlocked.')) {
        reject(new Error('Synthetic vault unlock failed.'));
      } else resolve();
    });
  });
  assert.equal(status(), 'unlocked');
}

const corruptRelease = mkdtempSync(join(tmpdir(), 'inflow-arch-corrupt-'));
try {
  cpSync(release, corruptRelease, { recursive: true });
  const packages = readdirSync(corruptRelease).filter((name) => name.endsWith('.pkg.tar.zst'));
  assert.equal(packages.length, 1);
  appendFileSync(join(corruptRelease, packages[0]), 'corrupted package');
  const rejected = spawnSync('sh', [installer], {
    encoding: 'utf8',
    env: { ...env, INFLOW_RELEASE_BASE_URL: `file://${corruptRelease}` },
    timeout: 120000,
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stdout + rejected.stderr, /checksum did NOT match/u);
  assert.equal(existsSync('/opt/inflow/bin/inflow'), false);
} finally {
  rmSync(corruptRelease, { recursive: true, force: true });
}

run('useradd', ['-m', '-u', '1001', 'testbuyer']);
run('sh', [installer]);
assert.equal(status(), 'not_initialized');
await unlock(true);
const keys = ['private.der', 'public.der'].map((name) => [name, readFileSync(`/var/lib/inflow-broker/${name}`)]);
const vaults = '/var/lib/inflow/vaults';
const headers = readdirSync(vaults)
  .map((name) => join(vaults, name, 'inflow.vault'))
  .filter(existsSync)
  .map((path) => [path, readFileSync(path)]);
assert.equal(headers.length, 1);
function preserved() {
  for (const [name, value] of keys) assert.deepEqual(readFileSync(`/var/lib/inflow-broker/${name}`), value);
  for (const [path, value] of headers) assert.deepEqual(readFileSync(path), value);
}

// Pacman invokes upgrade hooks for a same-version reinstall as well as a version upgrade.
run('sh', [installer]);
preserved();
assert.equal(status(), 'locked');
await unlock(false);
run('sh', [installer, '--uninstall']);
preserved();
assert.notEqual(spawnSync('inflow', ['--version']).status, 0);
run('sh', [installer]);
preserved();
assert.equal(status(), 'locked');
await unlock(false);
run('sh', [installer, '--purge']);
for (const path of ['/var/lib/inflow', '/var/lib/inflow-broker', '/run/inflow']) assert.equal(existsSync(path), false);
console.log('Arch signed install, upgrade hooks, non-root unlock, vault preservation, removal and purge passed.');
